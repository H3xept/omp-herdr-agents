/**
 * omp-herdr-agents: spawn omp subagents as visible, interactive omp sessions in
 * herdr workspaces, tabs, or panes — each in its own working directory.
 *
 * - `herdr_task` mirrors the built-in `task` tool: same agent types, batch
 *   shape, final-message result, live progress, and background delivery.
 * - `herdr_send` sends a follow-up to a spawned agent.
 * - `herdr_agents` lists, inspects, interrupts, and closes spawned agents.
 * - Spawned agents message the parent with `message_parent` (see `child.ts`).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import {
	allocateName,
	buildAssignment,
	buildChildArgv,
	buildSystemPrompt,
	chooseModel,
	findAgent,
} from "./agents";
import { formatOutcome, formatProgress, formatTranscript, formatUsage } from "./format";
import { HerdrError, type HerdrPane, herdr } from "./herdr";
import { ENV_RUN_DIR, readRunFile, SYSTEM_PROMPT_FILE } from "./protocol";
import { AgentRun, type Outcome, RunRecord, type RunHooks } from "./runs";

const CHILD_EXTENSION = path.join(import.meta.dir, "child.ts");
const START_TIMEOUT_MS = 60_000;
const PROMPT_TIMEOUT_MS = 60_000;
/** How long a freshly created pane may take to start its shell. */
const SHELL_READY_TIMEOUT_MS = 15_000;
const SHELL_READY_POLL_MS = 250;
const DEFAULT_TRANSCRIPT_LINES = 40;
/** Session entry that records a spawned agent, so a restarted parent can resume it. */
const RECORD_ENTRY = "omp-herdr-agent";
/** Session entry that marks a spawned agent as closed. */
const CLOSED_ENTRY = "omp-herdr-agent-closed";

const ClosedEntry = type({ name: "string" });

type Placement = "workspace" | "tab" | "pane";

interface Row {
	label: string;
	state: string;
}

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function resolveCwd(requested: string, base: string): Promise<string> {
	const expanded = requested === "~" || requested.startsWith("~/") ? path.join(os.homedir(), requested.slice(1)) : requested;
	const absolute = path.resolve(base, expanded);
	const stat = await fs.stat(absolute).catch(() => undefined);
	if (!stat?.isDirectory()) throw new Error(`cwd is not a directory: ${absolute}`);
	return fs.realpath(absolute);
}

async function placePane(opts: {
	placement: Placement;
	workspace?: string;
	cwd: string;
	label: string;
	env: Record<string, string>;
}): Promise<HerdrPane> {
	const { placement, cwd, label, env } = opts;
	if (placement === "workspace") return (await herdr.createWorkspace({ cwd, label, env })).root_pane;

	const callerPane = process.env.HERDR_PANE_ID;
	if (placement === "pane") {
		if (!callerPane) throw new Error("placement 'pane' needs HERDR_PANE_ID; this omp is not in a herdr pane.");
		const rect = await herdr.paneRect(callerPane);
		// Terminal cells are about twice as tall as wide: split wide panes sideways.
		const direction = rect && rect.width < rect.height * 2 ? "down" : "right";
		return (await herdr.splitPane({ pane: callerPane, direction, cwd, env })).pane;
	}

	const workspace =
		opts.workspace ??
		(await herdr.listPanes()).find(pane => pane.cwd === cwd)?.workspace_id ??
		process.env.HERDR_WORKSPACE_ID;
	if (!workspace) throw new Error("placement 'tab' needs a workspace id; none given and none found for this cwd.");
	return (await herdr.createTab({ workspace, cwd, label, env })).root_pane;
}

export default function ompHerdr(pi: ExtensionAPI) {
	// The tools drive the herdr session this process lives in; outside herdr there is none.
	if (process.env.HERDR_ENV !== "1") return;

	const z = pi.zod;
	const runs = new Map<string, AgentRun>();
	// A pane split measures the caller's pane to pick its direction. Placing one
	// pane at a time lets each split see the previous one, so a batch tiles
	// instead of slicing the caller into ever thinner columns.
	let placementQueue: Promise<unknown> = Promise.resolve();

	const hooks: RunHooks = {
		onMessages(run, messages) {
			const { name, agent, cwd } = run.record;
			const body = messages.map(message => message.text).join("\n\n");
			pi.sendMessage(
				{
					customType: "omp-herdr-message",
					content: [
						`<herdr-agent-message from="${name}">`,
						body,
						"</herdr-agent-message>",
						`The herdr agent \`${name}\` (${agent}, cwd ${cwd}) sent this with message_parent and keeps working.`,
						`If a reply is needed, send it with herdr_send (name "${name}", background true): it reaches the agent as a steer. No one replies on your behalf.`,
					].join("\n"),
					display: true,
					attribution: "agent",
				},
				{ deliverAs: "aside", triggerTurn: true },
			);
		},
		onDelivery(outcome) {
			pi.sendMessage(
				{
					customType: "omp-herdr-result",
					content: `herdr agent result:\n\n${formatOutcome(outcome)}`,
					display: true,
					attribution: "agent",
				},
				{ deliverAs: "aside", triggerTurn: true },
			);
		},
		onError(run, error) {
			pi.logger.error("omp-herdr: monitoring failed", { agent: run.name, error: describeError(error) });
		},
	};

	async function track(record: RunRecord): Promise<AgentRun> {
		const run = new AgentRun(record, hooks);
		runs.set(record.name, run);
		await run.start();
		return run;
	}

	function stopAll(reason: string) {
		for (const run of runs.values()) run.stop(reason);
		runs.clear();
	}

	/** Rebuild the tracked agents from the records on the session's active branch. */
	async function restore(ctx: ExtensionContext) {
		// Subagent sessions in this process load the extension too; only the main session owns herdr agents.
		if (ctx.agent.kind !== "main") return;
		stopAll("The parent session changed.");
		const records = new Map<string, RunRecord>();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === RECORD_ENTRY) {
				const record = RunRecord(entry.data);
				if (!(record instanceof type.errors)) records.set(record.name, record);
			} else if (entry.customType === CLOSED_ENTRY) {
				const closed = ClosedEntry(entry.data);
				if (!(closed instanceof type.errors)) records.delete(closed.name);
			}
		}
		for (const record of records.values()) {
			// The system may have cleaned the temp directory since.
			if (!(await fs.stat(record.runDir).catch(() => undefined))) continue;
			await track(record).catch(error =>
				pi.logger.error("omp-herdr: could not resume agent", { agent: record.name, error: describeError(error) }),
			);
		}
	}

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_switch", (_event, ctx) => restore(ctx));
	pi.on("session_branch", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.agent.kind === "main") stopAll("The parent session ended.");
	});

	function settingRecord(id: string): Record<string, unknown> {
		const value: unknown = lookup(id)?.get(pi.pi.settings);
		return value && typeof value === "object" ? Object.fromEntries(Object.entries(value)) : {};
	}

	function runNamed(name: string): AgentRun {
		const run = runs.get(name);
		if (run) return run;
		const known = [...runs.keys()].join(", ") || "none";
		throw new Error(`No herdr agent named "${name}" was spawned in this session. Known: ${known}.`);
	}

	async function spawn(
		item: { agent?: string; task: string; cwd: string; placement?: Placement; workspace?: string },
		name: string,
		context: string | undefined,
		ctx: ExtensionContext,
	): Promise<AgentRun> {
		const cwd = await resolveCwd(item.cwd, ctx.cwd);
		const agent = await findAgent(item.agent ?? "task", [ctx.cwd, cwd]);

		const override = settingRecord("task.agentModelOverrides")[agent.name];
		const patterns =
			typeof override === "string"
				? override.split(",").map(p => p.trim())
				: Array.isArray(override)
					? override.filter(p => typeof p === "string")
					: (agent.model ?? []);
		const known = new Set(pi.getAllTools().map(tool => tool.name));

		const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-herdr-"));
		const systemPromptFile = path.join(runDir, SYSTEM_PROMPT_FILE);
		await Bun.write(systemPromptFile, buildSystemPrompt({ agent, context, name, parentCwd: ctx.cwd, cwd }));
		const argv = buildChildArgv({
			childExtension: CHILD_EXTENSION,
			systemPromptFile,
			model: chooseModel(patterns, agent.thinkingLevel, ctx.models),
			tools: agent.tools?.filter(tool => known.has(tool)),
			// Headless `task` subagents run in yolo; a herdr agent should not stall on prompts either.
			approvalMode: process.env.OMP_HERDR_APPROVAL_MODE || "yolo",
		});

		const placed = placementQueue.then(() =>
			placePane({
				placement: item.placement ?? "workspace",
				workspace: item.workspace,
				cwd,
				label: name,
				env: { [ENV_RUN_DIR]: runDir },
			}),
		);
		placementQueue = placed.catch(() => undefined);
		const pane = await placed;
		// herdr reports a new pane as `agent_pane_busy` until its shell is up.
		const shellDeadline = Date.now() + SHELL_READY_TIMEOUT_MS;
		for (;;) {
			try {
				await herdr.startAgent({ name, pane: pane.pane_id, argv, timeoutMs: START_TIMEOUT_MS });
				break;
			} catch (error) {
				const starting = error instanceof HerdrError && error.code === "agent_pane_busy";
				if (!starting || Date.now() > shellDeadline) throw error;
				await Bun.sleep(SHELL_READY_POLL_MS);
			}
		}
		await herdr.prompt(name, buildAssignment(item.task), PROMPT_TIMEOUT_MS);
		const record: RunRecord = {
			name,
			agent: agent.name,
			cwd,
			paneId: pane.pane_id,
			workspaceId: pane.workspace_id,
			runDir,
			task: item.task.slice(0, 200),
			spawnedAt: new Date().toISOString(),
		};
		pi.appendEntry(RECORD_ENTRY, record);
		return track(record);
	}

	const useBackground = (requested: boolean | undefined) =>
		requested ?? lookup("async.enabled")?.get(pi.pi.settings) === true;

	const placementSchema = z
		.enum(["workspace", "tab", "pane"])
		.optional()
		.describe(
			"workspace (default): new herdr workspace. tab: new tab in `workspace`, else in a workspace already open at cwd, else yours. pane: split next to your pane.",
		);
	const backgroundSchema = z
		.boolean()
		.optional()
		.describe(
			"true: return at once; each result arrives later as its own message. Default: the session's async.enabled setting.",
		);
	const herdrTaskParams = z.object({
		context: z.string().optional().describe("Shared background added to every spawned agent's system prompt."),
		background: backgroundSchema,
		tasks: z
			.array(
				z.object({
					name: z.string().optional().describe("herdr agent name; lowercased, made unique. Default: the agent type."),
					agent: z.string().optional().describe("Agent type, as for `task`. Default: task."),
					task: z.string().describe("Complete, self-contained assignment."),
					cwd: z.string().describe("Working directory: absolute, ~/..., or relative to your cwd."),
					placement: placementSchema,
					workspace: z.string().optional().describe("herdr workspace id for placement 'tab'."),
				}),
			)
			.min(1),
	});
	const herdrSendParams = z.object({
		name: z.string().describe("herdr agent name returned by herdr_task."),
		message: z.string().describe("Follow-up instruction, question, or reply to a message_parent message."),
		background: backgroundSchema,
	});
	const herdrAgentsParams = z.object({
		action: z
			.enum(["list", "output", "transcript", "cancel", "close"])
			.describe(
				"list: every spawned agent with state and progress. output: an agent's latest final message in full. transcript: condensed recent activity from its session. cancel: interrupt its current turn (Esc). close: close its herdr pane and forget it.",
			),
		name: z.string().optional().describe("herdr agent name; required for every action except list."),
		lines: z.number().int().positive().optional().describe(`transcript: lines to return. Default ${DEFAULT_TRANSCRIPT_LINES}.`),
	});

	pi.registerTool({
		name: "herdr_task",
		label: "Herdr Task",
		loadMode: "essential",
		description: [
			"Spawn subagents as interactive omp sessions in herdr, each in its own working directory.",
			"Same agent types and contract as `task` (scout, task, reviewer, ...): each agent gets a self-contained assignment and its final message is the result.",
			"Use it when the work belongs to another directory or repository, or when the user wants to watch or steer the agent in herdr.",
			"While they work, agents may message you (`<herdr-agent-message>`); reply with `herdr_send`.",
			"Agents stay open in their panes after they finish: continue one with `herdr_send`; list, inspect, interrupt, or close them with `herdr_agents`. The `wait` tool and `proc://`/`agent://` do not see herdr agents.",
		].join("\n"),
		parameters: herdrTaskParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const taken = new Set([
				...runs.keys(),
				...(await herdr.listAgents()).flatMap(agent => (agent.name ? [agent.name] : [])),
			]);
			const names = params.tasks.map(item => allocateName(item.name ?? item.agent ?? "task", taken));
			const rows: Row[] = names.map((name, i) => ({
				label: `${name} (${params.tasks[i]?.agent ?? "task"})`,
				state: "starting",
			}));
			const update = () => {
				const text = rows.map(row => `- ${row.label}: ${row.state}`).join("\n");
				onUpdate?.({ content: [{ type: "text", text }], details: { rows } });
			};
			const setState = (i: number, state: string) => {
				const row = rows[i];
				if (row) row.state = state;
				update();
			};
			update();

			const spawned = await Promise.all(
				params.tasks.map(async (item, i) => {
					const name = names[i] ?? item.agent ?? "task";
					try {
						const run = await spawn(item, name, params.context, ctx);
						setState(i, `started in pane ${run.record.paneId}`);
						return run;
					} catch (error) {
						setState(i, `failed to start: ${describeError(error)}`);
						return error instanceof Error ? error : new Error(String(error));
					}
				}),
			);
			const started = spawned.filter((entry): entry is AgentRun => !(entry instanceof Error));
			const startErrors = spawned.flatMap((entry, i) =>
				entry instanceof Error ? [`## ${names[i]} — failed to start\nerror: ${entry.message}`] : [],
			);

			if (useBackground(params.background)) {
				await Promise.all(started.map(run => run.awaitInBackground(0)));
				const lines = started.map(
					({ record }) => `- \`${record.name}\` (${record.agent}) in herdr pane ${record.paneId}, cwd ${record.cwd}`,
				);
				const text = [
					started.length > 0
						? `Spawned ${started.length} herdr agent(s). Each result arrives as its own message when that agent finishes. Check on them with herdr_agents; the \`wait\` tool does not track herdr agents.`
						: "No herdr agent started.",
					...lines,
					...startErrors,
				].join("\n");
				return { content: [{ type: "text", text }], details: { rows }, isError: started.length === 0 };
			}

			const outcomes = await Promise.all(
				started.map(run => {
					const index = names.indexOf(run.name);
					const pane = `pane ${run.record.paneId}`;
					return run
						.wait(0, signal, progress => setState(index, `${formatProgress(progress, Date.now())} · ${pane}`))
						.then((outcome: Outcome) => {
							const usage = formatUsage(outcome.usage, outcome.toolCalls);
							setState(index, [outcome.status, usage, pane].filter(Boolean).join(" · "));
							return outcome;
						});
				}),
			);
			const text = [...outcomes.map(formatOutcome), ...startErrors].join("\n\n");
			const failed = outcomes.every(o => o.status !== "completed");
			return { content: [{ type: "text", text }], details: { rows }, isError: failed };
		},
	});

	pi.registerTool({
		name: "herdr_send",
		label: "Herdr Send",
		loadMode: "essential",
		description: [
			"Send a message to a herdr agent that `herdr_task` spawned in this session: a follow-up, or a reply to its message.",
			"A working agent reads it as a steer and keeps going in the same turn; an idle agent starts a new turn. The agent keeps its context.",
			"Returns the agent's next final message, or with background true returns at once and delivers it later as a message.",
		].join("\n"),
		parameters: herdrSendParams,
		async execute(_toolCallId, params, signal, onUpdate) {
			const run = runNamed(params.name);
			if (run.gone) throw new Error(`herdr agent ${run.name} no longer exists (pane ${run.record.paneId}).`);
			// Turns that ended before this message (including ones a human typed into the
			// pane) are not the reply. A message sent while the agent works steers the
			// current turn; its end is the reply.
			const afterSeq = await run.latestSeq();
			await herdr.prompt(run.name, params.message, PROMPT_TIMEOUT_MS);
			if (useBackground(params.background)) {
				await run.awaitInBackground(afterSeq);
				const text = `Sent to \`${run.name}\`. Its reply arrives as a message; the \`wait\` tool does not track herdr agents.`;
				return { content: [{ type: "text", text }] };
			}
			const outcome = await run.wait(afterSeq, signal, progress =>
				onUpdate?.({ content: [{ type: "text", text: `${run.name}: ${formatProgress(progress, Date.now())}` }] }),
			);
			return { content: [{ type: "text", text: formatOutcome(outcome) }], isError: outcome.status !== "completed" };
		},
	});

	pi.registerTool({
		name: "herdr_agents",
		label: "Herdr Agents",
		loadMode: "essential",
		description:
			"List, inspect, interrupt, or close the herdr agents that `herdr_task` spawned in this session. Use it where you would read `proc://` or `agent://` for `task` subagents.",
		parameters: herdrAgentsParams,
		async execute(_toolCallId, params) {
			const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

			if (params.action === "list") {
				if (runs.size === 0) return reply("No herdr agents spawned in this session.");
				const live = new Map((await herdr.listAgents()).map(agent => [agent.name, agent.agent_status]));
				const now = Date.now();
				const blocks = [...runs.values()].map(run => {
					const { record, progress, result } = run;
					const state = run.gone ? "gone" : (live.get(record.name) ?? "gone");
					const activity = progress?.state === "working" ? ` · ${formatProgress(progress, now)}` : "";
					const last = result
						? `${result.status} (turn ${result.seq}, ${result.finishedAt}) · ${formatUsage(result.usage, result.toolCalls)}`
						: "none yet";
					return [
						`- ${record.name} (${record.agent}) — ${state}${activity}`,
						`  pane ${record.paneId} · workspace ${record.workspaceId} · cwd ${record.cwd}`,
						`  task: ${record.task.replace(/\s+/g, " ")}`,
						`  last result: ${last}`,
					].join("\n");
				});
				return reply(blocks.join("\n"));
			}

			if (!params.name) throw new Error(`action "${params.action}" needs a name.`);
			const run = runNamed(params.name);
			const { record } = run;

			switch (params.action) {
				case "output": {
					const result = await readRunFile(record.runDir, "result");
					if (!result) return reply(`${record.name} has not finished a turn yet.`);
					const usage = formatUsage(result.usage, result.toolCalls);
					const header = `## ${record.name} — ${result.status} (turn ${result.seq}, ${result.finishedAt})${usage ? ` · ${usage}` : ""}`;
					const error = result.error ? `\nerror: ${result.error}` : "";
					return reply(`${header}${error}\n\n${result.output || "(no final message)"}`);
				}
				case "transcript": {
					const sessionFile =
						(await readRunFile(record.runDir, "progress"))?.sessionFile ?? run.result?.sessionFile;
					if (!sessionFile) throw new Error(`${record.name} has no session file yet.`);
					const text = await fs.readFile(sessionFile, "utf8");
					return reply(formatTranscript(text, params.lines ?? DEFAULT_TRANSCRIPT_LINES) || "(empty transcript)");
				}
				case "cancel": {
					const stopped = await run.interrupt();
					return reply(
						stopped
							? `Interrupted ${record.name}. Its turn ended as aborted; a waiting call or background request reports it.`
							: `Sent Esc to ${record.name}, but it still reports working. Check its pane ${record.paneId}.`,
					);
				}
				case "close": {
					await herdr.closePane(record.paneId).catch(error => {
						if (!(error instanceof HerdrError) || error.code !== "pane_not_found") throw error;
					});
					run.stop(`Closed by the parent agent.`);
					runs.delete(record.name);
					pi.appendEntry(CLOSED_ENTRY, { name: record.name });
					return reply(`Closed ${record.name} (pane ${record.paneId}).`);
				}
			}
		},
	});
}
