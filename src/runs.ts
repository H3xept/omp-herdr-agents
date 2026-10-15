/**
 * Parent-side monitor for one spawned herdr agent. It polls the agent's run
 * directory once a second and:
 * - keeps the latest progress and result for rows and `herdr_agents`;
 * - forwards new `message_parent` messages to the parent conversation;
 * - settles blocking waiters, and delivers results that background callers
 *   asked for;
 * - asks herdr whether the agent still exists while anyone waits for it.
 */
import { type } from "@oh-my-pi/pi-ai";
import { HerdrError, herdr } from "./herdr";
import {
	type ChildProgress,
	type ChildResult,
	type ChildStatus,
	type InboxMessage,
	type ParentState,
	readInbox,
	readRunFile,
	runFilePath,
	type Usage,
	writeRunFile,
} from "./protocol";

const POLL_MS = 1_000;
/** Esc presses `interrupt` sends at most: one to leave vim insert mode, one to abort, one spare. */
const INTERRUPT_ATTEMPTS = 3;
/** How long `interrupt` waits for the agent to leave `working` after each Esc. */
const INTERRUPT_SETTLE_MS = 1_500;
const INTERRUPT_CHECK_MS = 100;
/** herdr status checks run on every third poll, and only while someone waits. */
const STATUS_EVERY_TICKS = 3;

/** What the parent stores in its session for each spawned agent. */
export const RunRecord = type({
	name: "string",
	agent: "string",
	cwd: "string",
	paneId: "string",
	workspaceId: "string",
	runDir: "string",
	/** Start of the assignment, for listings. */
	task: "string",
	spawnedAt: "string",
});
export type RunRecord = typeof RunRecord.infer;

/** What a waiting call reports for one agent. */
export interface Outcome {
	record: RunRecord;
	status: ChildStatus | "lost";
	output: string;
	error?: string;
	durationMs: number;
	resultFile: string;
	usage?: Usage;
	toolCalls?: number;
}

export interface RunHooks {
	/** New `message_parent` messages, oldest first. */
	onMessages(run: AgentRun, messages: InboxMessage[]): void;
	/** A result that a background caller asked for. */
	onDelivery(outcome: Outcome): void;
	onError(run: AgentRun, error: unknown): void;
}

interface Waiter {
	afterSeq: number;
	startedAt: number;
	resolve(outcome: Outcome): void;
	onProgress?(progress: ChildProgress): void;
}

export class AgentRun {
	progress?: ChildProgress;
	result?: ChildResult;
	/** herdr's view of the agent from the latest status check. */
	herdrState?: string;
	/** Set once herdr no longer knows the agent; polling stops. */
	gone = false;

	#state: ParentState = { inboxForwarded: 0 };
	#waiters = new Set<Waiter>();
	#timer?: Timer;
	#ticks = 0;
	#busy = false;
	#stopped = false;

	constructor(
		readonly record: RunRecord,
		private readonly hooks: RunHooks,
	) {}

	get name(): string {
		return this.record.name;
	}

	/** Load state, poll once, then poll every second until `stop`. */
	async start(): Promise<void> {
		await this.open();
		this.#timer = setInterval(() => void this.poll(), POLL_MS);
		this.#timer.unref?.();
		await this.poll();
	}

	/** Load the parent-owned state, so a restarted parent resumes where the last one stopped. */
	async open(): Promise<void> {
		this.#state = (await readRunFile(this.record.runDir, "parent")) ?? { inboxForwarded: 0 };
	}

	/** Stop polling. Pending waiters settle as `lost` with `reason`. */
	stop(reason: string): void {
		this.#stopped = true;
		clearInterval(this.#timer);
		for (const waiter of this.#waiters) waiter.resolve(this.#outcome(waiter.startedAt, "lost", "", { error: reason }));
		this.#waiters.clear();
	}

	/** `seq` of the newest settled turn; 0 before the first. */
	async latestSeq(): Promise<number> {
		return (await readRunFile(this.record.runDir, "result"))?.seq ?? 0;
	}

	/**
	 * Resolve with the first result newer than `afterSeq`. When `signal` aborts,
	 * interrupt the agent's turn and resolve as `aborted`.
	 */
	wait(afterSeq: number, signal: AbortSignal | undefined, onProgress?: (progress: ChildProgress) => void): Promise<Outcome> {
		const { promise, resolve } = Promise.withResolvers<Outcome>();
		if (this.gone) {
			resolve(this.#outcome(Date.now(), "lost", "", { error: this.#goneReason() }));
			return promise;
		}
		const waiter: Waiter = { afterSeq, startedAt: Date.now(), resolve, onProgress };
		this.#waiters.add(waiter);
		signal?.addEventListener(
			"abort",
			() => {
				if (!this.#waiters.delete(waiter)) return;
				void (async () => {
					await this.interrupt().catch(() => undefined);
					const tail = await herdr.readTail(this.name, 40);
					resolve(this.#outcome(waiter.startedAt, "aborted", tail, { error: "Cancelled by the parent agent." }));
				})();
			},
			{ once: true },
		);
		return promise;
	}

	/**
	 * End the agent's current turn. Esc aborts a turn in omp, but in vim mode the
	 * first Esc only leaves insert mode. A second Esc in an idle omp has other
	 * meanings, so send the next Esc only while the agent still reports `working`.
	 * Resolve `true` once the agent left `working`.
	 */
	async interrupt(): Promise<boolean> {
		for (let attempt = 0; attempt < INTERRUPT_ATTEMPTS; attempt++) {
			await herdr.sendKeys(this.name, ["esc"]);
			const deadline = Date.now() + INTERRUPT_SETTLE_MS;
			while (Date.now() < deadline) {
				await Bun.sleep(INTERRUPT_CHECK_MS);
				if ((await readRunFile(this.record.runDir, "progress"))?.state !== "working") return true;
			}
		}
		return false;
	}

	/** Deliver the first result newer than `afterSeq` as a message, even after a parent restart. */
	async awaitInBackground(afterSeq: number): Promise<void> {
		this.#state.awaitingAfterSeq = afterSeq;
		this.#state.awaitingSince = new Date().toISOString();
		await writeRunFile(this.record.runDir, "parent", this.#state);
	}

	#goneReason(): string {
		return `herdr agent ${this.name} exited or left pane ${this.record.paneId} before reporting.`;
	}

	#outcome(startedAt: number, status: Outcome["status"], output: string, extra: Partial<Outcome> = {}): Outcome {
		return {
			record: this.record,
			status,
			output,
			durationMs: Date.now() - startedAt,
			resultFile: runFilePath(this.record.runDir, "result"),
			...extra,
		};
	}

	#fromResult(startedAt: number, result: ChildResult): Outcome {
		return this.#outcome(startedAt, result.status, result.output, {
			error: result.error,
			usage: result.usage,
			toolCalls: result.toolCalls,
		});
	}

	/** Read the run directory once and act on what changed. `start` calls this every second. */
	async poll(): Promise<void> {
		if (this.#busy || this.#stopped) return;
		this.#busy = true;
		try {
			const { runDir } = this.record;
			const progress = await readRunFile(runDir, "progress");
			if (progress) {
				this.progress = progress;
				for (const waiter of this.#waiters) waiter.onProgress?.(progress);
			}

			const inbox = await readInbox(runDir);
			if (inbox.length > this.#state.inboxForwarded) {
				const fresh = inbox.slice(this.#state.inboxForwarded);
				this.#state.inboxForwarded = inbox.length;
				await writeRunFile(runDir, "parent", this.#state);
				this.hooks.onMessages(this, fresh);
			}

			const result = await readRunFile(runDir, "result");
			if (result) {
				this.result = result;
				await this.#settle(result);
			}

			const watched = this.#waiters.size > 0 || this.#state.awaitingAfterSeq !== undefined;
			if (watched && this.#ticks % STATUS_EVERY_TICKS === 0) await this.#checkAlive();
			this.#ticks += 1;
		} catch (error) {
			this.hooks.onError(this, error);
		} finally {
			this.#busy = false;
		}
	}

	async #settle(result: ChildResult): Promise<void> {
		let consumed = false;
		for (const waiter of this.#waiters) {
			if (result.seq <= waiter.afterSeq) continue;
			this.#waiters.delete(waiter);
			waiter.resolve(this.#fromResult(waiter.startedAt, result));
			consumed = true;
		}
		if (this.#state.awaitingAfterSeq === undefined || result.seq <= this.#state.awaitingAfterSeq) return;
		const since = await this.#clearAwaiting();
		// A blocking call already returned this turn; do not deliver it twice.
		if (!consumed) this.hooks.onDelivery(this.#fromResult(since, result));
	}

	/** Drop the background request; return when it started. */
	async #clearAwaiting(): Promise<number> {
		const since = this.#state.awaitingSince ? Date.parse(this.#state.awaitingSince) : Date.now();
		this.#state.awaitingAfterSeq = undefined;
		this.#state.awaitingSince = undefined;
		await writeRunFile(this.record.runDir, "parent", this.#state);
		return since;
	}

	async #checkAlive(): Promise<void> {
		try {
			this.herdrState = (await herdr.getAgent(this.name)).agent_status;
			return;
		} catch (error) {
			if (!(error instanceof HerdrError) || error.code !== "agent_not_found") throw error;
		}
		// The agent may have reported just before it exited.
		const last = await readRunFile(this.record.runDir, "result");
		if (last) await this.#settle(last);
		this.gone = true;
		this.herdrState = "gone";
		const reason = this.#goneReason();
		if (this.#state.awaitingAfterSeq !== undefined) {
			const since = await this.#clearAwaiting();
			this.hooks.onDelivery(this.#outcome(since, "lost", "", { error: reason }));
		}
		this.stop(reason);
	}
}
