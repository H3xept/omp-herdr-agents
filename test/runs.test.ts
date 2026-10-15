import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendInbox, type ChildResult, readRunFile, writeRunFile } from "../src/protocol";
import { AgentRun, type Outcome, type RunHooks, type RunRecord } from "../src/runs";

let dir: string;
let fakeHerdr: string;
/** While this file exists, the fake herdr reports the agent as not found. */
let goneMarker: string;

beforeAll(async () => {
	// A herdr stand-in: `agent get` reports a working agent, or "not found" while `gone` exists.
	// Bun.spawn snapshots the environment at startup, so a marker file carries the switch.
	fakeHerdr = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "omp-herdr-bin-")), "herdr");
	goneMarker = path.join(path.dirname(fakeHerdr), "gone");
	await Bun.write(
		fakeHerdr,
		[
			"#!/bin/sh",
			'if [ -e "$(dirname "$0")/gone" ]; then echo \'{"id":1,"error":{"code":"agent_not_found","message":"gone"}}\' >&2; exit 1; fi',
			'echo \'{"id":1,"result":{"agent":{"pane_id":"p","tab_id":"t","workspace_id":"w","agent_status":"working"}}}\'',
			"",
		].join("\n"),
	);
	await fs.chmod(fakeHerdr, 0o755);
});

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-herdr-run-"));
	process.env.HERDR_BIN_PATH = fakeHerdr;
	await fs.rm(goneMarker, { force: true });
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

const record: () => RunRecord = () => ({
	name: "scout",
	agent: "scout",
	cwd: "/tmp",
	paneId: "w:p1",
	workspaceId: "w",
	runDir: dir,
	task: "t",
	spawnedAt: "2026-10-15T00:00:00Z",
});

const result = (seq: number, output: string): ChildResult => ({
	seq,
	status: "completed",
	output,
	finishedAt: new Date().toISOString(),
});

/** A monitor that the test polls by hand, with every hook call recorded. */
async function monitor() {
	const delivered: Outcome[] = [];
	const messages: string[] = [];
	const errors: unknown[] = [];
	const hooks: RunHooks = {
		onMessages: (_run, batch) => messages.push(...batch.map(message => message.text)),
		onDelivery: outcome => delivered.push(outcome),
		onError: (_run, error) => errors.push(error),
	};
	const run = new AgentRun(record(), hooks);
	await run.open();
	return { run, delivered, messages, errors };
}

describe("AgentRun", () => {
	test("a waiter ignores turns up to its baseline and resolves with the next one", async () => {
		const { run, errors } = await monitor();
		await writeRunFile(dir, "result", result(1, "old turn"));
		const reply = run.wait(1, undefined);
		await run.poll();
		await writeRunFile(dir, "result", result(2, "reply"));
		await run.poll();
		expect(await reply).toMatchObject({ status: "completed", output: "reply" });
		expect(errors).toEqual([]);
	});

	test("a background request is delivered once, and survives a parent restart", async () => {
		const before = await monitor();
		await before.run.awaitInBackground(0);
		before.run.stop("parent restarted");

		await writeRunFile(dir, "result", result(1, "done"));
		const after = await monitor();
		await after.run.poll();
		await after.run.poll();
		expect(after.delivered.map(outcome => outcome.output)).toEqual(["done"]);
		expect((await readRunFile(dir, "parent"))?.awaitingAfterSeq).toBeUndefined();
		expect(after.errors).toEqual([]);
	});

	test("a turn that a blocking call returned is not delivered again in the background", async () => {
		const { run, delivered } = await monitor();
		await run.awaitInBackground(0);
		const reply = run.wait(0, undefined);
		await writeRunFile(dir, "result", result(1, "done"));
		await run.poll();
		await run.poll();
		expect((await reply).output).toBe("done");
		expect(delivered).toEqual([]);
	});

	test("forwards each inbox message once, also across a parent restart", async () => {
		const before = await monitor();
		await appendInbox(dir, { at: "t1", text: "found the route" });
		await before.run.poll();
		await before.run.poll();
		before.run.stop("parent restarted");

		await appendInbox(dir, { at: "t2", text: "question" });
		const after = await monitor();
		await after.run.poll();
		expect(before.messages).toEqual(["found the route"]);
		expect(after.messages).toEqual(["question"]);
	});

	test("a waiter settles as lost once herdr no longer knows the agent", async () => {
		const { run, errors } = await monitor();
		const outcome = run.wait(0, undefined);
		await run.poll();
		expect(run.herdrState).toBe("working");

		await Bun.write(goneMarker, "");
		// herdr is asked on every third poll while someone waits.
		for (let i = 0; i < 3; i++) await run.poll();
		expect(await outcome).toMatchObject({ status: "lost" });
		expect(run.gone).toBe(true);
		expect(errors).toEqual([]);
	});
});
