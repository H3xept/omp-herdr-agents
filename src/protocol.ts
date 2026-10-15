/**
 * File protocol between the parent extension (`index.ts`) and the child
 * reporter (`child.ts`) that runs inside the spawned omp process.
 *
 * The parent creates one run directory per spawned agent and passes its path to
 * the child through the `OMP_HERDR_RUN_DIR` environment variable.
 *
 * Child-owned files:
 * - `result.json`: the latest settled turn; `seq` increases by one per turn, so
 *   the parent can tell the reply to a follow-up from an older turn.
 * - `progress.json`: live state of the current turn (tool calls, usage).
 * - `inbox.jsonl`: messages the child sent with `message_parent`, one per line.
 *
 * Parent-owned file:
 * - `parent.json`: how many inbox lines the parent forwarded, and which result
 *   it still owes to a background caller. It lets a restarted parent resume.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/pi-ai";

export const ENV_RUN_DIR = "OMP_HERDR_RUN_DIR";
export const SYSTEM_PROMPT_FILE = "system-prompt.md";
export const INBOX_FILE = "inbox.jsonl";
/** Tool the child reporter registers so the child can message the parent. */
export const MESSAGE_PARENT_TOOL = "message_parent";

const Usage = type({ input: "number", output: "number", cost: "number" });

const ChildResult = type({
	/** 1 for the first settled turn, then +1 per later turn. */
	seq: "number.integer",
	status: "'completed' | 'failed' | 'aborted'",
	/** Text of the final assistant message of the settled turn. */
	output: "string",
	"stopReason?": "string",
	"error?": "string",
	/** omp session file of the child, when it persists one. */
	"sessionFile?": "string",
	/** Tool calls of the settled turn. */
	"toolCalls?": "number.integer",
	/** Cumulative usage of the child session when the turn settled. */
	"usage?": Usage,
	finishedAt: "string",
});

const ChildProgress = type({
	state: "'working' | 'idle'",
	/** When the current (or last) turn started. */
	"turnStartedAt?": "string",
	/** Tool calls in the current (or last) turn. */
	toolCalls: "number.integer",
	/** Latest tool the agent called in this turn. */
	"tool?": "string",
	/** Intent of the latest tool call, as the child's model described it. */
	"intent?": "string",
	usage: Usage,
	"sessionFile?": "string",
	updatedAt: "string",
});

const ParentState = type({
	/** Inbox lines already forwarded into the parent conversation. */
	inboxForwarded: "number.integer",
	/** A background caller waits for the first result with `seq` above this. */
	"awaitingAfterSeq?": "number.integer",
	/** When the background caller started waiting, for the reported duration. */
	"awaitingSince?": "string",
});

const InboxMessage = type({ at: "string", text: "string" });

export type Usage = typeof Usage.infer;
export type ChildResult = typeof ChildResult.infer;
export type ChildStatus = ChildResult["status"];
export type ChildProgress = typeof ChildProgress.infer;
export type ParentState = typeof ParentState.infer;
export type InboxMessage = typeof InboxMessage.infer;

const RUN_FILES = {
	result: { file: "result.json", schema: ChildResult },
	progress: { file: "progress.json", schema: ChildProgress },
	parent: { file: "parent.json", schema: ParentState },
};

type RunFiles = typeof RUN_FILES;
export type RunFileKind = keyof RunFiles;
type RunFileValue<K extends RunFileKind> = RunFiles[K]["schema"]["infer"];

export function runFilePath(runDir: string, kind: RunFileKind): string {
	return path.join(runDir, RUN_FILES[kind].file);
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Read and validate one run file; `undefined` while the file does not exist. */
export async function readRunFile<K extends RunFileKind>(runDir: string, kind: K): Promise<RunFileValue<K> | undefined> {
	const file = runFilePath(runDir, kind);
	let raw: string;
	try {
		raw = await fs.readFile(file, "utf8");
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
	const parsed = RUN_FILES[kind].schema(JSON.parse(raw));
	if (parsed instanceof type.errors) throw new Error(`${file}: ${parsed.summary}`);
	return parsed;
}

/** Write one run file atomically so the other side never reads a partial file. */
export async function writeRunFile<K extends RunFileKind>(runDir: string, kind: K, value: RunFileValue<K>): Promise<void> {
	const target = runFilePath(runDir, kind);
	const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(value, null, 2));
	await fs.rename(tmp, target);
}

export async function appendInbox(runDir: string, message: InboxMessage): Promise<void> {
	await fs.appendFile(path.join(runDir, INBOX_FILE), `${JSON.stringify(message)}\n`);
}

/** All complete inbox lines, oldest first. A line still being written is skipped. */
export async function readInbox(runDir: string): Promise<InboxMessage[]> {
	const file = path.join(runDir, INBOX_FILE);
	let raw: string;
	try {
		raw = await fs.readFile(file, "utf8");
	} catch (error) {
		if (isMissing(error)) return [];
		throw error;
	}
	const complete = raw.slice(0, raw.lastIndexOf("\n") + 1);
	return complete
		.split("\n")
		.filter(line => line.length > 0)
		.map(line => {
			const parsed = InboxMessage(JSON.parse(line));
			if (parsed instanceof type.errors) throw new Error(`${file}: ${parsed.summary}`);
			return parsed;
		});
}
