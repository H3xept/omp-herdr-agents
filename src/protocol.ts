/**
 * File protocol between the parent extension (`index.ts`) and the child
 * reporter (`child.ts`) that runs inside the spawned omp process.
 *
 * The parent creates one run directory per spawned agent and passes its path to
 * the child through the `OMP_HERDR_RUN_DIR` environment variable. The child
 * writes `result.json` there each time its main agent settles; `seq` increases
 * by one per settled turn so the parent can wait for the reply to a follow-up.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";

export const ENV_RUN_DIR = "OMP_HERDR_RUN_DIR";
export const RESULT_FILE = "result.json";
export const SYSTEM_PROMPT_FILE = "system-prompt.md";

const ChildResultSchema = type({
	/** 1 for the first settled turn, then +1 per later turn. */
	seq: "number.integer",
	status: "'completed' | 'failed' | 'aborted'",
	/** Text of the final assistant message of the settled turn. */
	output: "string",
	"stopReason?": "string",
	"error?": "string",
	/** omp session file of the child, when it persists one. */
	"sessionFile?": "string",
	finishedAt: "string",
});

export type ChildResult = typeof ChildResultSchema.infer;
export type ChildStatus = ChildResult["status"];

export async function readResult(runDir: string): Promise<ChildResult | undefined> {
	const file = path.join(runDir, RESULT_FILE);
	let raw: string;
	try {
		raw = await fs.readFile(file, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
	const parsed = ChildResultSchema(JSON.parse(raw));
	if (parsed instanceof type.errors) throw new Error(`${file}: ${parsed.summary}`);
	return parsed;
}

/** Write the result atomically so the parent never reads a partial file. */
export async function writeResult(runDir: string, result: ChildResult): Promise<void> {
	const target = path.join(runDir, RESULT_FILE);
	const tmp = `${target}.${process.pid}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(result, null, 2));
	await fs.rename(tmp, target);
}
