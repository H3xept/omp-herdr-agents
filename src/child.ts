/**
 * Child-side reporter. The parent passes this file with `-e` to the omp process
 * it starts in a herdr pane. It keeps the parent informed through the run
 * directory:
 * - each settled turn of the main agent goes to `result.json`;
 * - live turn state (tool calls, usage) goes to `progress.json`;
 * - the `message_parent` tool appends messages for the parent to `inbox.jsonl`.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AgentEndEvent } from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import {
	appendInbox,
	type ChildProgress,
	type ChildResult,
	ENV_RUN_DIR,
	MESSAGE_PARENT_TOOL,
	type Usage,
	writeRunFile,
} from "./protocol";

export function summarizeTurn(
	messages: AgentEndEvent["messages"],
): Pick<ChildResult, "status" | "output" | "stopReason" | "error"> {
	const last = messages.findLast(message => message.role === "assistant");
	if (last?.role !== "assistant") {
		return { status: "failed", output: "", error: "The agent ended without an assistant message." };
	}
	const output = last.content
		.flatMap(block => (block.type === "text" ? [block.text] : []))
		.join("\n")
		.trim();
	return {
		status: last.stopReason === "aborted" ? "aborted" : last.stopReason === "error" ? "failed" : "completed",
		output,
		stopReason: last.stopReason,
		...(last.errorMessage ? { error: last.errorMessage } : {}),
	};
}

export default function ompHerdrChild(pi: ExtensionAPI) {
	const runDir = process.env[ENV_RUN_DIR];
	if (!runDir) return;

	let seq = 0;
	const progress: ChildProgress = {
		state: "idle",
		toolCalls: 0,
		usage: { input: 0, output: 0, cost: 0 },
		updatedAt: new Date().toISOString(),
	};
	// Writes run in order, so a slow write never overwrites a newer state.
	let writes: Promise<void> = Promise.resolve();

	function usageOf(ctx: ExtensionContext): Usage {
		const stats = ctx.sessionManager.getUsageStatistics();
		return { input: stats.input, output: stats.output, cost: stats.cost };
	}

	// An arrow function, so TypeScript keeps `runDir` narrowed to `string`.
	const publish = (ctx: ExtensionContext, change: Partial<ChildProgress>) => {
		Object.assign(progress, change, {
			usage: usageOf(ctx),
			sessionFile: ctx.sessionManager.getSessionFile(),
			updatedAt: new Date().toISOString(),
		});
		const snapshot = { ...progress };
		writes = writes
			.then(() => writeRunFile(runDir, "progress", snapshot))
			.catch(error => pi.logger.error("omp-herdr child: progress write failed", { error: String(error) }));
		return writes;
	};

	// Factories rebind to every subagent session in this process; only the
	// pane's main agent reports to the parent.
	pi.on("agent_start", async (_event, ctx) => {
		if (ctx.agent.kind !== "main" || progress.state === "working") return;
		await publish(ctx, {
			state: "working",
			turnStartedAt: new Date().toISOString(),
			toolCalls: 0,
			tool: undefined,
			intent: undefined,
		});
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		await publish(ctx, { toolCalls: progress.toolCalls + 1, tool: event.toolName, intent: event.intent });
	});

	pi.on("agent_end", async (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		if (event.willContinue) return;
		// The agent ended its turn while its own background jobs still run; their
		// results start another turn, which reports instead.
		if ((ctx.getAsyncJobSnapshot()?.running.length ?? 0) > 0) return;

		seq += 1;
		const usage = usageOf(ctx);
		await writeRunFile(runDir, "result", {
			seq,
			...summarizeTurn(event.messages),
			sessionFile: ctx.sessionManager.getSessionFile(),
			toolCalls: progress.toolCalls,
			usage,
			finishedAt: new Date().toISOString(),
		});
		await publish(ctx, { state: "idle" });
	});

	const messageParentParams = pi.zod.object({ message: pi.zod.string().describe("Message for the parent agent.") });
	pi.registerTool({
		name: MESSAGE_PARENT_TOOL,
		label: "Message Parent",
		loadMode: "essential",
		description: [
			"Send a message to the parent omp agent that assigned your work, while you keep working.",
			"Use it for findings the parent needs before you finish, or for a question it can answer while you continue.",
			"It does not wait for a reply. A reply arrives later as a user message. Your final message still carries your result.",
		].join("\n"),
		parameters: messageParentParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.agent.kind !== "main") {
				throw new Error("Only the pane's main agent can message the parent agent.");
			}
			await appendInbox(runDir, { at: new Date().toISOString(), text: params.message });
			return {
				content: [
					{
						type: "text",
						text: "Delivered to the parent agent. It may be busy or waiting for your result: keep working and do not wait for a reply.",
					},
				],
			};
		},
	});
}
