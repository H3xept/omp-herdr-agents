import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { summarizeTurn } from "../src/child";
import { RESULT_FILE, readResult, writeResult } from "../src/protocol";

describe("result file", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-herdr-test-"));
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("is absent until the child reports", async () => {
		expect(await readResult(dir)).toBeUndefined();
	});

	test("round-trips the latest report", async () => {
		const report = { seq: 2, status: "completed" as const, output: "PELICAN", finishedAt: "2026-10-15T00:00:00Z" };
		await writeResult(dir, { ...report, seq: 1 });
		await writeResult(dir, report);
		expect(await readResult(dir)).toEqual(report);
	});

	test("rejects a malformed report instead of returning it", async () => {
		await Bun.write(path.join(dir, RESULT_FILE), JSON.stringify({ seq: "1", status: "done" }));
		await expect(readResult(dir)).rejects.toThrow(RESULT_FILE);
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

	test("reports the final assistant text, not earlier turns or thinking", () => {
		const messages = [assistant("toolUse", "working on it"), { role: "user", content: "x" }, assistant("stop", "PELICAN")];
		// Only role/content/stopReason are read; full AgentMessage objects carry unrelated metadata.
		const turn = messages as unknown as Parameters<typeof summarizeTurn>[0];
		expect(summarizeTurn(turn)).toMatchObject({ status: "completed", output: "PELICAN" });
	});

	test("maps provider errors and aborts to failed and aborted", () => {
		const failed = [assistant("error", "", "429 rate limited")] as unknown as Parameters<typeof summarizeTurn>[0];
		const aborted = [assistant("aborted", "partial")] as unknown as Parameters<typeof summarizeTurn>[0];
		expect(summarizeTurn(failed)).toMatchObject({ status: "failed", error: "429 rate limited" });
		expect(summarizeTurn(aborted)).toMatchObject({ status: "aborted", output: "partial" });
	});

	test("fails a turn without any assistant message", () => {
		expect(summarizeTurn([])).toMatchObject({ status: "failed", output: "" });
	});
});
