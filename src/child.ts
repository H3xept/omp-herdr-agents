/**
 * Child-side reporter. The parent passes this file with `-e` to the omp process
 * it starts in a herdr pane. Each time the child's main agent settles, the
 * reporter writes the final assistant message to the run directory, where the
 * parent's `herdr_task` / `herdr_send` call is waiting for it.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { AgentEndEvent } from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import { type ChildResult, ENV_RUN_DIR, writeResult } from "./protocol";

export function summarizeTurn(messages: AgentEndEvent["messages"]): Omit<ChildResult, "seq" | "finishedAt"> {
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

	pi.on("agent_end", async (event, ctx) => {
		// Factories rebind to every subagent session in this process; only the
		// pane's main agent answers the parent.
		if (ctx.agent.kind !== "main") return;
		if (event.willContinue) return;
		// The agent ended its turn while its own background jobs still run; their
		// results start another turn, which reports instead.
		if ((ctx.getAsyncJobSnapshot()?.running.length ?? 0) > 0) return;

		seq += 1;
		await writeResult(runDir, {
			seq,
			...summarizeTurn(event.messages),
			sessionFile: ctx.sessionManager.getSessionFile(),
			finishedAt: new Date().toISOString(),
		});
	});
}
