import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { summarizeTurn } from "../src/child";
import { appendInbox, INBOX_FILE, readInbox, readRunFile, runFilePath, writeRunFile } from "../src/protocol";

let dir: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-herdr-test-"));
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

describe("run files", () => {
	test("are absent until written", async () => {
		expect(await readRunFile(dir, "result")).toBeUndefined();
	});

	test("round-trip the latest write", async () => {
		const report = { seq: 2, status: "completed" as const, output: "PELICAN", finishedAt: "2026-10-15T00:00:00Z" };
		await writeRunFile(dir, "result", { ...report, seq: 1 });
		await writeRunFile(dir, "result", report);
		expect(await readRunFile(dir, "result")).toEqual(report);
	});

	test("reject a malformed file instead of returning it", async () => {
		await Bun.write(runFilePath(dir, "result"), JSON.stringify({ seq: "1", status: "done" }));
		await expect(readRunFile(dir, "result")).rejects.toThrow("result.json");
	});
});

describe("inbox", () => {
	test("returns messages oldest first", async () => {
		await appendInbox(dir, { at: "t1", text: "first" });
		await appendInbox(dir, { at: "t2", text: "second" });
		expect((await readInbox(dir)).map(message => message.text)).toEqual(["first", "second"]);
	});

	test("skips a line the child is still writing", async () => {
		await appendInbox(dir, { at: "t1", text: "complete" });
		await fs.appendFile(path.join(dir, INBOX_FILE), '{"at":"t2","te');
		expect((await readInbox(dir)).map(message => message.text)).toEqual(["complete"]);
	});
});

describe("summarizeTurn", () => {
	const assistant = (stopReason: string, text: string, errorMessage?: string) => ({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "hidden" },
			{ type: "text", text },
		],
		stopReason,
		errorMessage,
	});
	// Only role/content/stopReason are read; full AgentMessage objects carry unrelated metadata.
	type Turn = Parameters<typeof summarizeTurn>[0];

	test("reports the final assistant text, not earlier turns or thinking", () => {
		const messages = [assistant("toolUse", "working on it"), { role: "user", content: "x" }, assistant("stop", "PELICAN")];
		expect(summarizeTurn(messages as unknown as Turn)).toMatchObject({ status: "completed", output: "PELICAN" });
	});

	test("maps provider errors and aborts to failed and aborted", () => {
		const failed = [assistant("error", "", "429 rate limited")] as unknown as Turn;
		const aborted = [assistant("aborted", "partial")] as unknown as Turn;
		expect(summarizeTurn(failed)).toMatchObject({ status: "failed", error: "429 rate limited" });
		expect(summarizeTurn(aborted)).toMatchObject({ status: "aborted", output: "partial" });
	});

	test("fails a turn without any assistant message", () => {
		expect(summarizeTurn([])).toMatchObject({ status: "failed", output: "" });
	});
});
