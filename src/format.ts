/**
 * Text the parent shows the model and the user: progress rows, results, and
 * condensed child transcripts.
 */
import { type } from "@oh-my-pi/pi-ai";
import type { ChildProgress, Usage } from "./protocol";
import type { Outcome } from "./runs";

/** Results longer than this are cut in tool output; the full text stays in `result.json`. */
export const MAX_INLINE_OUTPUT = 30_000;

export function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
	return String(count);
}

/** `6 tools · 12.3K tokens · $0.012`; parts without data are left out. */
export function formatUsage(usage: Usage | undefined, toolCalls: number | undefined): string {
	const parts: string[] = [];
	if (toolCalls !== undefined) parts.push(`${toolCalls} tool${toolCalls === 1 ? "" : "s"}`);
	if (usage) parts.push(`${formatTokens(usage.input + usage.output)} tokens`, `$${usage.cost.toFixed(3)}`);
	return parts.join(" · ");
}

/** One-line live state: `working · read: Reading the login route · 6 tools · 14s · $0.012`. */
export function formatProgress(progress: ChildProgress, now: number): string {
	const parts: string[] = [progress.state];
	if (progress.state === "working") {
		const activity = progress.intent ?? progress.tool;
		if (activity) parts.push(activity);
	}
	parts.push(formatUsage(progress.usage, progress.toolCalls));
	if (progress.state === "working" && progress.turnStartedAt) {
		parts.push(formatDuration(now - Date.parse(progress.turnStartedAt)));
	}
	return parts.filter(part => part.length > 0).join(" · ");
}

export function formatOutcome(outcome: Outcome): string {
	const { record } = outcome;
	const header = `## ${record.name} (${record.agent}) — ${outcome.status} in ${formatDuration(outcome.durationMs)}`;
	const where = `herdr pane ${record.paneId} · workspace ${record.workspaceId} · cwd ${record.cwd}`;
	const usage = formatUsage(outcome.usage, outcome.toolCalls);
	const output =
		outcome.output.length > MAX_INLINE_OUTPUT
			? `${outcome.output.slice(0, MAX_INLINE_OUTPUT)}\n\n[truncated; read it with herdr_agents action "output", or ${outcome.resultFile}]`
			: outcome.output;
	const lines = [header, usage ? `${where} · ${usage}` : where];
	if (outcome.error) lines.push(`error: ${outcome.error}`);
	lines.push("", output || "(no final message)");
	return lines.join("\n");
}

const Block = type({ type: "string", "text?": "string", "name?": "string", "intent?": "string", "arguments?": "unknown" });
const SessionLine = type({
	type: "string",
	"message?": {
		role: "string",
		content: type("string").or(Block.array()),
		"toolName?": "string",
		"isError?": "boolean",
	},
});

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Condense an omp session file (JSONL) into the last `limit` transcript lines:
 * user and assistant text, tool calls with their intent, and failed tool results.
 */
export function formatTranscript(jsonl: string, limit: number): string {
	const lines: string[] = [];
	for (const raw of jsonl.split("\n")) {
		if (!raw.trim()) continue;
		const entry = SessionLine(JSON.parse(raw));
		if (entry instanceof type.errors || entry.type !== "message" || !entry.message) continue;
		const { role, content } = entry.message;
		const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
		if (role === "toolResult") {
			if (!entry.message.isError) continue;
			const text = blocks.flatMap(block => (block.text ? [block.text] : [])).join(" ");
			lines.push(`    ✗ ${entry.message.toolName ?? "tool"} failed: ${clip(text, 200)}`);
			continue;
		}
		for (const block of blocks) {
			if (block.type === "text" && block.text?.trim()) {
				lines.push(`${role === "user" ? "› user" : "‹ assistant"}: ${clip(block.text, role === "user" ? 400 : 600)}`);
			} else if (block.type === "toolCall" && block.name) {
				lines.push(`  · ${block.name}: ${clip(block.intent ?? JSON.stringify(block.arguments ?? {}), 160)}`);
			}
		}
	}
	const shown = lines.slice(-limit);
	const skipped = lines.length - shown.length;
	return [...(skipped > 0 ? [`[${skipped} earlier lines omitted]`] : []), ...shown].join("\n");
}
