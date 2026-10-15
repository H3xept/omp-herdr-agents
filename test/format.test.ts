import { describe, expect, test } from "bun:test";
import { formatProgress, formatTranscript } from "../src/format";

const line = (role: string, content: unknown, extra: Record<string, unknown> = {}) =>
	JSON.stringify({ type: "message", id: "x", parentId: null, timestamp: "t", message: { role, content, ...extra } });

describe("formatTranscript", () => {
	const session = [
		JSON.stringify({ type: "model_change", model: "m" }),
		line("user", [{ type: "text", text: "Find the login route." }]),
		line("assistant", [
			{ type: "thinking", thinking: "secret reasoning" },
			{ type: "toolCall", id: "1", name: "grep", intent: "Finding login routes", arguments: { pattern: "login" } },
		]),
		line("toolResult", [{ type: "text", text: "src/routes/login.ts" }], { toolName: "grep", isError: false }),
		line("assistant", [{ type: "toolCall", id: "2", name: "read", arguments: { path: "missing.ts" } }]),
		line("toolResult", [{ type: "text", text: "ENOENT: missing.ts" }], { toolName: "read", isError: true }),
		line("assistant", [{ type: "text", text: "Login lives in src/routes/login.ts." }]),
	].join("\n");

	test("shows messages, tool intents, and failures, but not thinking or successful output", () => {
		const text = formatTranscript(session, 50);
		expect(text.split("\n")).toEqual([
			"› user: Find the login route.",
			"  · grep: Finding login routes",
			'  · read: {"path":"missing.ts"}',
			"    ✗ read failed: ENOENT: missing.ts",
			"‹ assistant: Login lives in src/routes/login.ts.",
		]);
	});

	test("keeps the most recent lines and says how many it dropped", () => {
		const text = formatTranscript(session, 2);
		expect(text.split("\n")).toEqual([
			"[3 earlier lines omitted]",
			"    ✗ read failed: ENOENT: missing.ts",
			"‹ assistant: Login lives in src/routes/login.ts.",
		]);
	});
});

describe("formatProgress", () => {
	const base = { toolCalls: 6, usage: { input: 10_000, output: 2_345, cost: 0.0123 }, updatedAt: "t" };

	test("a working agent shows the intent of its latest tool call, and the turn time", () => {
		const now = Date.parse("2026-10-15T12:00:14Z");
		const progress = {
			...base,
			state: "working" as const,
			tool: "read",
			intent: "Reading the login route",
			turnStartedAt: "2026-10-15T12:00:00Z",
		};
		expect(formatProgress(progress, now)).toBe("working · Reading the login route · 6 tools · 12.3K tokens · $0.012 · 14s");
	});

	test("a working agent falls back to the tool name when the call has no intent", () => {
		const now = Date.parse("2026-10-15T12:00:14Z");
		const progress = { ...base, state: "working" as const, tool: "read", turnStartedAt: "2026-10-15T12:00:00Z" };
		expect(formatProgress(progress, now)).toBe("working · read · 6 tools · 12.3K tokens · $0.012 · 14s");
	});

	test("an idle agent shows only totals", () => {
		const progress = { ...base, state: "idle" as const, intent: "Reading the login route" };
		expect(formatProgress(progress, Date.now())).toBe("idle · 6 tools · 12.3K tokens · $0.012");
	});
});
