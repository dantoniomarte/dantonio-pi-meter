/**
 * Session meter state.
 *
 * Token totals come from provider-reported usage: parent message_end events,
 * the session's own entries (bootstrap on start, so resumed or reloaded
 * sessions start from the full history), settled gentle-pi subagent events,
 * and the extension's own persisted child snapshots (custom entries appended
 * at settle time, restored on session start so the child totals survive
 * resume and reload). The live rate is measured only on the parent: streamed
 * output characters are a proxy for live tokens/second. The session average
 * covers every timed agent: the parent's measured generation time plus each
 * settled child's decode timing, read from its session JSONL on disk (per
 * assistant message `durationMs`, joined through the task record's
 * `sessionPath`); children without readable timing contribute tokens but not
 * time. Subagent events also carry task wall time (launchedAt -> settledAt),
 * which feeds the +N sa @R task-throughput segment (tool time included), a
 * different unit from any decode rate.
 *
 * Field semantics follow pi's canonical usage split (see /session-info):
 * `input` is the uncached portion, `cacheRead` the tokens served from cache,
 * and `cacheWrite` the tokens written to cache. The full prompt volume is
 * `input + cacheRead + cacheWrite`; the renderer shows that volume as `in`.
 */

import { addUsage, emptyUsage, sumUsage, type Usage } from "./format.ts";

/** Entry shapes foldEntries understands; everything else is ignored. */
interface LooseEntry {
	type?: string;
	message?: { role?: string; usage?: Partial<Usage> };
	usage?: Partial<Usage>;
}

/** customType of the cumulative avg-timing entries appended to the session. */
export const AVG_TIMING_TYPE = "dantonio-pi-meter:avg-timing/v1";

/** Cumulative parent timing the session average needs to survive resume. */
export interface GenerationTiming {
	/** Accumulated parent generation time, ms. Excludes the live response. */
	generationMs: number;
	/** Output tokens of responses whose generation time is in generationMs. */
	timedOutput: number;
}

/** One settled child's decode timing, read from its session JSONL on disk. */
export interface ChildTiming {
	/** Summed assistant-message generation duration, ms. */
	generationMs: number;
	/** Output tokens of the messages whose duration is in generationMs. */
	timedOutput: number;
}

/** Anything longer than a day of wall time is clock-mix garbage, not a task. */
const MAX_PLAUSIBLE_WALL_MS = 86_400_000;

/**
 * Wall time is only kept when it is a finite, positive, sub-day duration.
 * Older persisted snapshots mixed an epoch-ms settle with a performance.now()
 * launch and stored ~1.795e12 ms per task; those windows are dropped while
 * their tokens still count.
 */
function sanitizeWall(wallMs: number): number {
	return Number.isFinite(wallMs) && wallMs > 0 && wallMs <= MAX_PLAUSIBLE_WALL_MS ? Math.round(wallMs) : 0;
}

export interface MeterState {
	parent: Usage;
	/** One snapshot per settled subagent task, keyed by task id. */
	children: Map<string, Usage>;
	/** One settled wall-time window (ms) per subagent task, keyed by task id. */
	childrenMs: Map<string, number>;
	/** Sum of settled subagent wall time, ms. Tracks childrenMs. */
	subagentMs: number;
	/** One settled decode-timing snapshot per subagent task, keyed by task id. */
	childrenTiming: Map<string, ChildTiming>;
	/** Sum of settled child generation time, ms. Tracks childrenTiming. */
	childTimingMs: number;
	/** Output tokens counted with childTimingMs. Tracks childrenTiming. */
	childTimedOutput: number;
	subagents: number;
	/** Output characters seen in the current parent response. */
	liveChars: number;
	/** When the current parent response started emitting, ms. */
	liveStartedAt?: number;
	/** Cumulative parent timing the session average is built on. */
	generationMs: number;
	timedOutput: number;
}

/** Payload appended to the parent session as a custom entry after each settle. */
export interface ChildSnapshotData {
	taskId: string;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	/** Settled wall-time window in ms, when known. */
	wallMs?: number;
	/** Child decode timing folded into the combined average, when known. */
	timingMs?: number;
	/** Output tokens counted with timingMs. */
	timedOutput?: number;
	/** Tombstone: the task was revoked; drop it instead of folding tokens. */
	revoked?: boolean;
}

/** customType of the extension's own persisted child snapshots. */
export const CHILD_SNAPSHOT_TYPE = "dantonio-pi-meter:child-usage/v1";

export function createState(): MeterState {
	return {
		parent: emptyUsage(),
		children: new Map(),
		childrenMs: new Map(),
		childrenTiming: new Map(),
		childTimingMs: 0,
		childTimedOutput: 0,
		subagentMs: 0,
		subagents: 0,
		liveChars: 0,
		generationMs: 0,
		timedOutput: 0,
	};
}

export function noteDelta(state: MeterState, chars: number, now: number): void {
	if (chars <= 0) return;
	state.liveStartedAt ??= now;
	state.liveChars += chars;
}

export function endParentResponse(state: MeterState, usage: Partial<Usage> | undefined, now: number): void {
	if (usage) addUsage(state.parent, usage);
	if (state.liveStartedAt !== undefined) {
		state.generationMs += Math.max(0, now - state.liveStartedAt);
		state.timedOutput += usage?.output && usage.output > 0 ? usage.output : 0;
	}
	state.liveChars = 0;
	state.liveStartedAt = undefined;
}

/**
 * Seed parent totals from a session's entries (ReadonlySessionManager.getEntries()).
 * Mirrors pi's canonical aggregation so a resumed or reloaded session starts
 * where /session-info stands. Returns the number of folded usage-bearing entries.
 */
export function foldEntries(state: MeterState, entries: readonly unknown[] | undefined): number {
	if (!Array.isArray(entries)) return 0;
	let folded = 0;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as LooseEntry;
		let usage: Partial<Usage> | undefined;
		if (candidate.type === "message") {
			const role = candidate.message?.role;
			if ((role === "assistant" || role === "toolResult") && candidate.message?.usage) usage = candidate.message.usage;
		} else if (candidate.type === "usage" || candidate.type === "compaction" || candidate.type === "branch_summary") {
			usage = candidate.usage;
		}
		if (usage) {
			addUsage(state.parent, usage);
			folded += 1;
		}
	}
	return folded;
}

function reported(responses: unknown, field: string): number {
	if (!Array.isArray(responses)) return 0;
	let total = 0;
	for (const response of responses) {
		const tokens = (response as { tokens?: Record<string, { state?: unknown; value?: unknown }> } | null)?.tokens;
		const measurement = tokens?.[field];
		if (measurement?.state === "reported" && typeof measurement.value === "number" && Number.isFinite(measurement.value) && measurement.value > 0) {
			total += measurement.value;
		}
	}
	return total;
}

function sameUsage(a: Usage | undefined, b: Usage): boolean {
	return a !== undefined && a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite;
}

/**
 * Fold one settled gentle-pi child metrics event. The event is a complete
 * snapshot for its task, so a repeated task id replaces the stored snapshot
 * and its wall-time window (identical re-delivery is a no-op). Wall time is
 * settledAt - launchedAt, both provided by the caller in ms; a degenerate or
 * absent window replaces any stored one. Returns true when totals changed.
 */
export function noteChild(state: MeterState, event: unknown, settledAt?: number, launchedAt?: number, timing?: ChildTiming): boolean {
	if (!event || typeof event !== "object") return false;
	const candidate = event as { taskId?: unknown; responses?: unknown };
	if (typeof candidate.taskId !== "string" || candidate.taskId.length === 0) return false;
	const usage: Partial<Usage> = {};
	let any = false;
	for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		const value = reported(candidate.responses, field);
		if (value > 0) {
			usage[field] = value;
			any = true;
		}
	}
	if (!any) return false;
	const wallMs = settledAt !== undefined && launchedAt !== undefined
		&& Number.isFinite(settledAt) && Number.isFinite(launchedAt)
		? Math.max(0, Math.round(settledAt - launchedAt))
		: 0;
	return setChild(state, candidate.taskId, usage, wallMs, timing);
}

/**
 * Store or replace one child task's snapshot. Both the bus event and the
 * persisted-session fold funnel through here, so a repeated task id replaces
 * the stored snapshot and its wall-time window (identical re-delivery is a
 * no-op) no matter which path delivered it. `wallMs <= 0` means unknown: a
 * degenerate or absent window replaces any stored one. Same for the decode
 * timing: absent or degenerate timing replaces any stored one, so an untimed
 * re-delivery never stacks with an older timing. Returns true when totals
 * changed.
 */
function setChild(state: MeterState, taskId: string, usage: Partial<Usage>, rawWallMs: number, timing?: ChildTiming): boolean {
	const wallMs = sanitizeWall(rawWallMs);
	const snapshot: Usage = {
		input: usage.input ?? 0,
		output: usage.output ?? 0,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
	};
	const previousMs = state.childrenMs.get(taskId);
	if (wallMs > 0) {
		state.childrenMs.set(taskId, wallMs);
		state.subagentMs += wallMs - (previousMs ?? 0);
	} else if (previousMs !== undefined) {
		state.childrenMs.delete(taskId);
		state.subagentMs -= previousMs;
	}
	applyChildTiming(state, taskId, timing);
	if (sameUsage(state.children.get(taskId), snapshot)) return false;
	if (!state.children.has(taskId)) state.subagents += 1;
	state.children.set(taskId, snapshot);
	return true;
}

/**
 * Store, replace, or clear one child's decode timing with the same replace
 * semantics as its wall-time window: a degenerate or absent timing (unreadable
 * session file, for example) drops any stored one instead of stacking zeros.
 * Returns true when the timing aggregate changed.
 */
function applyChildTiming(state: MeterState, taskId: string, timing?: ChildTiming): boolean {
	const valid = timing !== undefined && timing.generationMs > 0 && timing.timedOutput > 0 ? timing : undefined;
	const previous = state.childrenTiming.get(taskId);
	if (valid) {
		if (previous !== undefined && previous.generationMs === valid.generationMs && previous.timedOutput === valid.timedOutput) return false;
		state.childrenTiming.set(taskId, valid);
		state.childTimingMs += valid.generationMs - (previous?.generationMs ?? 0);
		state.childTimedOutput += valid.timedOutput - (previous?.timedOutput ?? 0);
		return true;
	}
	if (previous === undefined) return false;
	state.childrenTiming.delete(taskId);
	state.childTimingMs -= previous.generationMs;
	state.childTimedOutput -= previous.timedOutput;
	return true;
}

/**
 * Attach decode timing to an already-folded child — the disk backfill path for
 * snapshots restored from older sessions or persisted before their session
 * read succeeded. No-op for unknown tasks. Returns true when totals changed.
 */
export function setChildTiming(state: MeterState, taskId: string, timing: ChildTiming): boolean {
	if (!state.children.has(taskId)) return false;
	return applyChildTiming(state, taskId, timing);
}

/**
 * Apply one child snapshot payload — the exact shape appended to the parent
 * session with `pi.appendEntry(CHILD_SNAPSHOT_TYPE, data)`. A tombstone
 * (`revoked: true`) drops the task. Returns true when totals changed.
 */
export function applyChildSnapshot(state: MeterState, data: unknown): boolean {
	if (!data || typeof data !== "object") return false;
	const candidate = data as ChildSnapshotData;
	if (typeof candidate.taskId !== "string" || candidate.taskId.length === 0) return false;
	if (candidate.revoked === true) return dropChild(state, candidate.taskId);
	const usage: Partial<Usage> = {};
	let any = false;
	for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		const value = candidate[field];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) {
			usage[field] = value;
			any = true;
		}
	}
	if (!any) return false;
	const wallMs = typeof candidate.wallMs === "number" && Number.isFinite(candidate.wallMs)
		? Math.max(0, Math.round(candidate.wallMs))
		: 0;
	// Persisted timing rides the same plausibility gate as wall time; a
	// degenerate value leaves the child untimed instead of poisoning avg.
	let timing: ChildTiming | undefined;
	const timingMs = typeof candidate.timingMs === "number" && Number.isFinite(candidate.timingMs) ? sanitizeWall(candidate.timingMs) : 0;
	const timedOutput = typeof candidate.timedOutput === "number" && Number.isFinite(candidate.timedOutput) ? Math.max(0, Math.round(candidate.timedOutput)) : 0;
	if (timingMs > 0 && timedOutput > 0) timing = { generationMs: timingMs, timedOutput };
	return setChild(state, candidate.taskId, usage, wallMs, timing);
}

function validSnapshotPayload(data: unknown): data is ChildSnapshotData {
	if (!data || typeof data !== "object") return false;
	const candidate = data as ChildSnapshotData;
	if (typeof candidate.taskId !== "string" || candidate.taskId.length === 0) return false;
	if (candidate.revoked === true) return true;
	return (["input", "output", "cacheRead", "cacheWrite"] as const).some((field) => {
		const value = candidate[field];
		return typeof value === "number" && Number.isFinite(value) && value > 0;
	});
}

/**
 * Restore subagent snapshots from a session's custom entries (the extension's
 * own CHILD_SNAPSHOT_TYPE ones). Returns the number of valid payloads applied,
 * including tombstones — a tombstone for an unknown task still counts as
 * applied. Later entries win, mirroring bus re-delivery.
 */
export function foldChildEntries(state: MeterState, entries: readonly unknown[] | undefined): number {
	if (!Array.isArray(entries)) return 0;
	let folded = 0;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as { type?: string; customType?: string; data?: unknown };
		if (candidate.type !== "custom" || candidate.customType !== CHILD_SNAPSHOT_TYPE) continue;
		if (validSnapshotPayload(candidate.data)) {
			applyChildSnapshot(state, candidate.data);
			folded += 1;
		}
	}
	return folded;
}

/** Drop one subagent task's tokens, wall time, and decode timing after a revocation. Returns true if it was stored. */
export function dropChild(state: MeterState, taskId: string): boolean {
	const wallMs = state.childrenMs.get(taskId);
	if (wallMs !== undefined) {
		state.childrenMs.delete(taskId);
		state.subagentMs -= wallMs;
	}
	applyChildTiming(state, taskId);
	if (!state.children.delete(taskId)) return false;
	state.subagents -= 1;
	return true;
}

/**
 * Persist the cumulative parent timing so a resumed session rebuilds the same
 * session average instead of restarting it from zero. Callers append this
 * after every timed parent response; the payload replaces on fold.
 * Returns true when an entry was appended.
 */
export function persistTiming(state: MeterState, appendEntry: (customType: string, data?: unknown) => void): boolean {
	if (state.generationMs <= 0 || state.timedOutput <= 0) return false;
	try {
		appendEntry(AVG_TIMING_TYPE, { generationMs: state.generationMs, timedOutput: state.timedOutput });
	} catch {
		return false;
	}
	return true;
}

/**
 * Restore the cumulative avg timing from a session's AVG_TIMING_TYPE custom
 * entries. Entries are cumulative snapshots: the last valid one wins, so a
 * re-fired session_start folds the same entries again without stacking.
 * Returns the number of valid payloads applied.
 */
export function foldTimingEntries(state: MeterState, entries: readonly unknown[] | undefined): number {
	if (!Array.isArray(entries)) return 0;
	let folded = 0;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as { type?: string; customType?: string; data?: unknown };
		if (candidate.type !== "custom" || candidate.customType !== AVG_TIMING_TYPE) continue;
		const data = candidate.data as Partial<GenerationTiming> | undefined;
		const generationMs = typeof data?.generationMs === "number" && Number.isFinite(data.generationMs) && data.generationMs >= 0
			? data.generationMs
			: undefined;
		const timedOutput = typeof data?.timedOutput === "number" && Number.isFinite(data.timedOutput) && data.timedOutput >= 0
			? data.timedOutput
			: undefined;
		if (generationMs === undefined || timedOutput === undefined) continue;
		state.generationMs = generationMs;
		state.timedOutput = timedOutput;
		folded += 1;
	}
	return folded;
}

export interface Rates {
	live?: number;
	average?: number;
	/** Aggregate settled-subagent task throughput (output tokens / wall seconds). */
	subagent?: number;
}

/**
 * Live rate from streamed chars; session average from reported output / time.
 * `subagent` is the aggregate settled-task throughput: total child output over
 * total settled wall seconds. Task wall time includes queueing, thinking and
 * tool execution, so it reads lower than a decode rate by design.
 */
export function rates(state: MeterState, now: number, charsPerToken = 4): Rates {
	const liveMs = state.liveStartedAt === undefined ? 0 : Math.max(0, now - state.liveStartedAt);
	const live = liveMs >= 250 && state.liveChars > 0 ? (state.liveChars / charsPerToken) / (liveMs / 1000) : undefined;
	// Session average over every timed agent: parent + settled children.
	// Children with unreadable or missing timing contribute tokens but not
	// time, so the average stays over the timed subset — never a guess.
	const generationMs = state.generationMs + state.childTimingMs;
	const timedOutput = state.timedOutput + state.childTimedOutput;
	const average = generationMs >= 250 && timedOutput > 0 ? timedOutput / (generationMs / 1000) : undefined;
	let childOutput = 0;
	for (const child of state.children.values()) childOutput += child.output;
	const subagent = state.subagentMs >= 250 && childOutput > 0 ? childOutput / (state.subagentMs / 1000) : undefined;
	return { live, average, subagent };
}

export function totals(state: MeterState): Usage {
	let total = state.parent;
	for (const child of state.children.values()) total = sumUsage(total, child);
	return { input: total.input, output: total.output, cacheRead: total.cacheRead, cacheWrite: total.cacheWrite };
}
