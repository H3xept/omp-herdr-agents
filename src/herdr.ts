/**
 * Typed wrapper over the `herdr` CLI. Every control command prints a JSON
 * envelope `{ id, result }` on success, or `{ id, error: { code, message } }`
 * on stderr with exit status 1. Responses are validated before use.
 */
import { type } from "@oh-my-pi/pi-ai";

export class HerdrError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "HerdrError";
	}
}

const Pane = type({
	pane_id: "string",
	tab_id: "string",
	workspace_id: "string",
	"cwd?": "string",
});

const Agent = type({
	pane_id: "string",
	tab_id: "string",
	workspace_id: "string",
	"name?": "string",
	agent_status: "string",
	"agent_session?": { kind: "string", value: "string" },
});

export type HerdrPane = typeof Pane.infer;
export type HerdrAgent = typeof Agent.infer;

const ErrorEnvelope = type({ error: { code: "string", message: "string" } });

interface Spawned {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function run(args: string[]): Promise<Spawned> {
	const proc = Bun.spawn([process.env.HERDR_BIN_PATH || "herdr", ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Run a herdr command and validate `.result` of its JSON envelope against `schema`. */
async function call<T>(args: string[], schema: (input: unknown) => T | InstanceType<typeof type.errors>): Promise<T> {
	const out = await run(args);
	const command = `herdr ${args.slice(0, 2).join(" ")}`;
	if (out.exitCode !== 0) {
		const text = (out.stderr || out.stdout).trim();
		const envelope = ErrorEnvelope(parseJson(text));
		if (envelope instanceof type.errors) {
			throw new HerdrError("cli_error", `${command} exited ${out.exitCode}: ${text}`);
		}
		throw new HerdrError(envelope.error.code, envelope.error.message);
	}
	const body = parseJson(out.stdout);
	const result = schema(body && typeof body === "object" && "result" in body ? body.result : undefined);
	if (result instanceof type.errors) {
		throw new HerdrError("bad_response", `${command} returned an unexpected shape: ${result.summary}`);
	}
	return result;
}

const envFlags = (env: Record<string, string>) => Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);

const CreatedWorkspace = type({ workspace: { workspace_id: "string" }, root_pane: Pane });
const CreatedTab = type({ tab: { tab_id: "string" }, root_pane: Pane });
const SplitPane = type({ pane: Pane });
const Layout = type({
	layout: { panes: type({ pane_id: "string", rect: { width: "number", height: "number" } }).array() },
});
const PaneList = type({ panes: Pane.array() });
const AgentList = type({ agents: Agent.array() });
const AgentResult = type({ agent: Agent });
const Ok = type("unknown");

export const herdr = {
	createWorkspace(opts: { cwd: string; label: string; env: Record<string, string> }) {
		return call(
			["workspace", "create", "--cwd", opts.cwd, "--label", opts.label, ...envFlags(opts.env), "--no-focus"],
			CreatedWorkspace,
		);
	},

	createTab(opts: { workspace: string; cwd: string; label: string; env: Record<string, string> }) {
		return call(
			[
				"tab",
				"create",
				"--workspace",
				opts.workspace,
				"--cwd",
				opts.cwd,
				"--label",
				opts.label,
				...envFlags(opts.env),
				"--no-focus",
			],
			CreatedTab,
		);
	},

	splitPane(opts: { pane: string; direction: "right" | "down"; cwd: string; env: Record<string, string> }) {
		return call(
			[
				"pane",
				"split",
				"--pane",
				opts.pane,
				"--direction",
				opts.direction,
				"--cwd",
				opts.cwd,
				...envFlags(opts.env),
				"--no-focus",
			],
			SplitPane,
		);
	},

	async paneRect(pane: string) {
		const { layout } = await call(["pane", "layout", "--pane", pane], Layout);
		return layout.panes.find(p => p.pane_id === pane)?.rect;
	},

	async listPanes() {
		return (await call(["pane", "list"], PaneList)).panes;
	},

	async listAgents() {
		return (await call(["agent", "list"], AgentList)).agents;
	},

	async getAgent(target: string) {
		return (await call(["agent", "get", target], AgentResult)).agent;
	},

	async startAgent(opts: { name: string; pane: string; argv: string[]; timeoutMs: number }) {
		const args = ["agent", "start", opts.name, "--kind", "omp", "--pane", opts.pane];
		args.push("--timeout", String(opts.timeoutMs), "--", ...opts.argv);
		return (await call(args, AgentResult)).agent;
	},

	/**
	 * Submit a prompt. Returns once herdr observes the agent pick it up
	 * (`working`), or settle again for an instant reply.
	 */
	async prompt(target: string, text: string, timeoutMs: number) {
		const states = ["working", "done", "idle", "blocked"].flatMap(state => ["--until", state]);
		const args = ["agent", "prompt", target, text, "--wait", ...states, "--timeout", String(timeoutMs)];
		return (await call(args, AgentResult)).agent;
	},

	async closePane(pane: string) {
		await call(["pane", "close", pane], Ok);
	},

	async sendKeys(target: string, keys: string[]) {
		await call(["agent", "send-keys", target, ...keys], Ok);
	},

	/** Plain-text tail of the agent's terminal; empty when unreadable. */
	async readTail(target: string, lines: number) {
		const out = await run(["agent", "read", target, "--source", "recent-unwrapped", "--lines", String(lines)]);
		return out.exitCode === 0 ? out.stdout.trimEnd() : "";
	},
};
