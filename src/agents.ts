/**
 * Turns an omp agent definition (the same `scout`, `task`, `reviewer`, ...
 * definitions the built-in `task` tool uses) into the inputs of an interactive
 * omp process: an appended system prompt, CLI flags, and the first prompt.
 */
import type { ExtensionModelQuery } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { discoverAgents, getAgent } from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

export type { AgentDefinition };

const THINKING_LEVELS: Record<string, true> = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
	auto: true,
};

/**
 * Find an agent definition by name. Discovery runs from each directory in
 * order, so the caller's project agents win over the target project's.
 */
export async function findAgent(name: string, cwds: readonly string[]): Promise<AgentDefinition> {
	const known = new Set<string>();
	for (const cwd of cwds) {
		const { agents } = await discoverAgents(cwd);
		const agent = getAgent(agents, name);
		if (agent) return agent;
		for (const candidate of agents) known.add(candidate.name);
	}
	throw new Error(`Unknown agent "${name}". Available agents: ${[...known].sort().join(", ")}.`);
}

export interface ModelChoice {
	/** `provider/id` for `omp --model`; absent when no pattern resolves. */
	model?: string;
	thinking?: string;
}

/**
 * Pick the first model pattern that resolves in this session, mirroring the
 * `task` tool's ordered fallback list. A `:level` suffix on the winning pattern
 * overrides the agent's thinking level.
 */
export function chooseModel(
	patterns: readonly string[],
	agentThinking: string | undefined,
	models: Pick<ExtensionModelQuery, "resolve" | "current">,
): ModelChoice {
	for (const pattern of patterns) {
		const resolved = models.resolve(pattern);
		if (!resolved) continue;
		const suffix = pattern.slice(pattern.lastIndexOf(":") + 1);
		const thinking = pattern.includes(":") && THINKING_LEVELS[suffix] ? suffix : agentThinking;
		return { model: `${resolved.provider}/${resolved.id}`, thinking };
	}
	const current = models.current();
	return { model: current ? `${current.provider}/${current.id}` : undefined, thinking: agentThinking };
}

export interface PromptInputs {
	agent: AgentDefinition;
	context?: string;
	name: string;
	parentCwd: string;
	cwd: string;
}

/** System-prompt addendum: the agent's role plus the herdr completion contract. */
export function buildSystemPrompt({ agent, context, name, parentCwd, cwd }: PromptInputs): string {
	const sections = [`§ Role\n${agent.systemPrompt.trim()}`];
	if (context?.trim()) sections.push(`§ Context\n${context.trim()}`);
	sections.push(
		[
			"§ Coop",
			"You are operating on a piece of work assigned to you by a parent omp agent.",
			`You run as an interactive omp session in a herdr pane; your herdr agent name is \`${name}\`.`,
			"A human can watch this pane and may type to you directly; treat their messages as authoritative.",
			`Your working directory is \`${cwd}\`. The parent agent works in \`${parentCwd}\`.`,
		].join("\n"),
	);
	const completion = [
		"§ Completion",
		"No TODO tracking, no progress updates. Execute; your final message is your result.",
		"While work remains, you MUST continue with another tool call. A reply without a tool call ends your turn; its text reaches the parent agent verbatim as your complete result. NEVER end on a plan, a promise of further work, or a question.",
		"No `yield` tool exists: ROLE mentions of `yield`, sections, or output fields describe what your final message covers.",
	];
	if (agent.output !== undefined) {
		completion.push(
			"Your final message MUST be a single JSON object, without a code fence, matching this schema:",
			"```json",
			JSON.stringify(agent.output, null, 2),
			"```",
		);
	}
	completion.push(
		"Giving up is a last resort. If truly blocked, your final message MUST describe what you tried and the exact blocker.",
		"Later messages in this session are follow-ups from the parent agent or the human; answer each one the same way.",
	);
	sections.push(completion.join("\n"));
	return `${sections.join("\n\n")}\n`;
}

export function buildAssignment(task: string): string {
	return `Complete assignment thoroughly:\n\n${task.trim()}`;
}

export interface ChildArgvInputs {
	childExtension: string;
	systemPromptFile: string;
	model: ModelChoice;
	tools?: readonly string[];
	approvalMode?: string;
}

/** Arguments for `omp` after `herdr agent start ... --`. */
export function buildChildArgv({ childExtension, systemPromptFile, model, tools, approvalMode }: ChildArgvInputs): string[] {
	const argv = ["-e", childExtension, "--append-system-prompt", systemPromptFile];
	if (model.model) argv.push("--model", model.model);
	if (model.thinking) argv.push("--thinking", model.thinking);
	if (tools && tools.length > 0) argv.push("--tools", tools.join(","));
	if (approvalMode) argv.push("--approval-mode", approvalMode);
	return argv;
}

/** Herdr agent names must match `[a-z][a-z0-9_-]{0,31}` and be unique among live agents. */
export function allocateName(requested: string, taken: Set<string>): string {
	const cleaned = requested
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^[^a-z]+/, "")
		.replace(/-+$/, "")
		.slice(0, 28);
	const base = cleaned || "agent";
	let name = base;
	for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
	taken.add(name);
	return name;
}
