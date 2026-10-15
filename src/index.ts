/**
 * omp-herdr: spawn omp subagents as visible, interactive omp sessions in herdr
 * workspaces, tabs, or panes — each in its own working directory.
 *
 * `herdr_task` mirrors the built-in `task` tool (same agent types, batch shape,
 * final-message result); `herdr_send` sends a follow-up to an agent it spawned.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
import { HerdrError, type HerdrPane, herdr } from "./herdr";
import { type ChildResult, ENV_RUN_DIR, readResult, SYSTEM_PROMPT_FILE } from "./protocol";

const CHILD_EXTENSION = path.join(import.meta.dir, "child.ts");
const START_TIMEOUT_MS = 60_000;
const PROMPT_TIMEOUT_MS = 60_000;
const POLL_MS = 1_000;
const STATUS_EVERY_POLLS = 3;
const MAX_INLINE_OUTPUT = 30_000;
/** How long a freshly created pane may take to start its shell. */
const SHELL_READY_TIMEOUT_MS = 15_000;
const SHELL_READY_POLL_MS = 250;

type Placement = "workspace" | "tab" | "pane";

/** One spawned herdr agent, tracked for follow-ups and result delivery. */
interface Run {
	name: string;
	agent: string;
	cwd: string;
	paneId: string;
	workspaceId: string;
	runDir: string;
}

/** What a waiting call reports for one agent. */
interface Outcome {
	run: Run;
	status: ChildResult["status"] | "lost";
	output: string;
	error?: string;
	durationMs: number;
	resultFile: string;
}

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

function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function formatOutcome(outcome: Outcome): string {
	const { run } = outcome;
	const header = `## ${run.name} (${run.agent}) — ${outcome.status} in ${formatDuration(outcome.durationMs)}`;
	const where = `herdr pane ${run.paneId} · workspace ${run.workspaceId} · cwd ${run.cwd}`;
	const output =
		outcome.output.length > MAX_INLINE_OUTPUT
			? `${outcome.output.slice(0, MAX_INLINE_OUTPUT)}\n\n[truncated; full output in ${outcome.resultFile}]`
			: outcome.output;
	const lines = [header, where];
	if (outcome.error) lines.push(`error: ${outcome.error}`);
	lines.push("", output || "(no final message)");
	return lines.join("\n");
}

export default function ompHerdr(pi: ExtensionAPI) {
	// The tools drive the herdr session this process lives in; outside herdr there is none.
	if (process.env.HERDR_ENV !== "1") return;

	const z = pi.zod;
	const runs = new Map<string, Run>();

	function settingRecord(id: string): Record<string, unknown> {
		const value: unknown = lookup(id)?.get(pi.pi.settings);
		return value && typeof value === "object" ? Object.fromEntries(Object.entries(value)) : {};
	}

	async function spawn(
		item: { agent?: string; task: string; cwd: string; placement?: Placement; workspace?: string },
		name: string,
		context: string | undefined,
		ctx: ExtensionContext,
	): Promise<Run> {
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

		const pane = await placePane({
			placement: item.placement ?? "workspace",
			workspace: item.workspace,
			cwd,
			label: name,
			env: { [ENV_RUN_DIR]: runDir },
		});
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
		return { name, agent: agent.name, cwd, paneId: pane.pane_id, workspaceId: pane.workspace_id, runDir };
	}

	/**
	 * Poll the run directory for the first result newer than `afterSeq`; watch
	 * herdr for an agent that quit. Each waiter keeps its own baseline, so a
	 * background waiter and a `herdr_send` waiter on one agent both see the turn.
	 */
	async function waitForResult(
		run: Run,
		afterSeq: number,
		signal: AbortSignal | undefined,
		onState: (state: string) => void,
	) {
		const startedAt = Date.now();
		const outcome = (status: Outcome["status"], output: string, error?: string): Outcome => ({
			run,
			status,
			output,
			error,
			durationMs: Date.now() - startedAt,
			resultFile: path.join(run.runDir, "result.json"),
		});
		for (let poll = 0; ; poll++) {
			const result = await readResult(run.runDir);
			if (result && result.seq > afterSeq) {
				return outcome(result.status, result.output, result.error);
			}
			if (signal?.aborted) {
				await herdr.sendKeys(run.name, ["esc"]).catch(() => undefined);
				return outcome("aborted", await herdr.readTail(run.name, 40), "Cancelled by the parent agent.");
			}
			if (poll % STATUS_EVERY_POLLS === 0) {
				try {
					onState((await herdr.getAgent(run.name)).agent_status);
				} catch (error) {
					if (!(error instanceof HerdrError) || error.code !== "agent_not_found") throw error;
					// The agent may have reported just before it exited.
					const last = await readResult(run.runDir);
					if (last && last.seq > afterSeq) continue;
					return outcome("lost", "", `herdr agent ${run.name} exited or left pane ${run.paneId} before reporting.`);
				}
			}
			await Bun.sleep(POLL_MS);
		}
	}

	function deliverLater(outcomes: Promise<Outcome[]>) {
		outcomes
			.then(settled => {
				pi.sendMessage(
					{
						customType: "omp-herdr-result",
						content: `herdr agent results:\n\n${settled.map(formatOutcome).join("\n\n")}`,
						display: true,
						attribution: "agent",
					},
					{ deliverAs: "aside", triggerTurn: true },
				);
			})
			.catch(error => {
				pi.logger.error("omp-herdr: background wait failed", { error: describeError(error) });
			});
	}

	const placementSchema = z
		.enum(["workspace", "tab", "pane"])
		.optional()
		.describe(
			"workspace (default): new herdr workspace. tab: new tab in `workspace`, else in a workspace already open at cwd, else yours. pane: split next to your pane.",
		);
	const backgroundSchema = z
		.boolean()
		.optional()
		.describe("true: return at once; results arrive later as a message. Default: the session's async.enabled setting.");
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
		message: z.string().describe("Follow-up instruction or question."),
		background: backgroundSchema,
	});

	pi.registerTool({
		name: "herdr_task",
		label: "Herdr Task",
		loadMode: "essential",
		description: [
			"Spawn subagents as interactive omp sessions in herdr, each in its own working directory.",
			"Same agent types and contract as `task` (scout, task, reviewer, ...): each agent gets a self-contained assignment and its final message is the result.",
			"Use it when the work belongs to another directory or repository, or when the user wants to watch or steer the agent in herdr.",
			"Agents stay open in their panes after they finish; continue one with `herdr_send`.",
		].join("\n"),
		parameters: herdrTaskParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const taken = new Set((await herdr.listAgents()).flatMap(agent => (agent.name ? [agent.name] : [])));
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
						runs.set(run.name, run);
						setState(i, `running in pane ${run.paneId}`);
						return run;
					} catch (error) {
						setState(i, `failed to start: ${describeError(error)}`);
						return error instanceof Error ? error : new Error(String(error));
					}
				}),
			);
			const started = spawned.filter((entry): entry is Run => !(entry instanceof Error));
			const startErrors = spawned.flatMap((entry, i) =>
				entry instanceof Error ? [`## ${names[i]} — failed to start\nerror: ${entry.message}`] : [],
			);

			const background = params.background ?? lookup("async.enabled")?.get(pi.pi.settings) === true;
			if (background) {
				if (started.length > 0) deliverLater(Promise.all(started.map(run => waitForResult(run, 0, undefined, () => {}))));
				const lines = started.map(run => `- \`${run.name}\` (${run.agent}) in herdr pane ${run.paneId}, cwd ${run.cwd}`);
				const text = [
					started.length > 0
						? `Spawned ${started.length} herdr agent(s). Their results arrive together as one message once all finish. The \`wait\` tool does not track herdr agents: continue other work or end your turn.`
						: "No herdr agent started.",
					...lines,
					...startErrors,
				].join("\n");
				return { content: [{ type: "text", text }], details: { rows }, isError: started.length === 0 };
			}

			const outcomes = await Promise.all(
				started.map(run => {
					const index = names.indexOf(run.name);
					return waitForResult(run, 0, signal, state => setState(index, `${state} in pane ${run.paneId}`)).then(outcome => {
						setState(index, outcome.status);
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
		description:
			"Send a follow-up message to a herdr agent that `herdr_task` spawned in this session, and return its next final message. The agent keeps its context.",
		parameters: herdrSendParams,
		async execute(_toolCallId, params, signal, onUpdate) {
			const run = runs.get(params.name);
			if (!run) {
				const known = [...runs.keys()].join(", ") || "none";
				throw new Error(`No herdr agent named "${params.name}" was spawned in this session. Known: ${known}.`);
			}
			// Turns that ended before this message (including ones a human typed into the
			// pane) are not the reply. A message sent while the agent works steers the
			// current turn; its end is the reply.
			const afterSeq = (await readResult(run.runDir))?.seq ?? 0;
			await herdr.prompt(run.name, params.message, PROMPT_TIMEOUT_MS);
			const background = params.background ?? lookup("async.enabled")?.get(pi.pi.settings) === true;
			if (background) {
				deliverLater(waitForResult(run, afterSeq, undefined, () => {}).then(outcome => [outcome]));
				const text = `Sent to \`${run.name}\`. Its reply arrives as a message; the \`wait\` tool does not track herdr agents.`;
				return { content: [{ type: "text", text }] };
			}
			const outcome = await waitForResult(run, afterSeq, signal, state =>
				onUpdate?.({ content: [{ type: "text", text: `${run.name}: ${state}` }] }),
			);
			return { content: [{ type: "text", text: formatOutcome(outcome) }], isError: outcome.status !== "completed" };
		},
	});
}
