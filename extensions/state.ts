/**
 * Session meter state.
 *
 * Token totals come from provider-reported usage: parent message_end events,
 * the session's own entries (bootstrap on start, so resumed or reloaded
 * sessions start from the full history), and settled gentle-pi subagent
 * events. Speed is measured only on the parent: streamed output characters
 * are a proxy for live tokens/second, and the session average is total output
 * tokens divided by measured generation time. Subagent events report tokens
 * but not duration, so they cannot move the average's denominator.
 *
 * Field semantics follow pi's canonical usage split (see /session-info):
 * `input` is the uncached portion, `cacheRead` the tokens served from cache,
 * and `cacheWrite` the tokens written to cache. The full prompt volume is
 * `input + cacheRead + cacheWrite`; the renderer shows that volume as `in`.
 */

import { addUsage, emptyUsage, sumUsage, type Usage } from "./format.ts";

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"] as const;

/** Entry shapes foldEntries understands; everything else is ignored. */
interface LooseEntry {
	type?: string;
	message?: { role?: string; usage?: Partial<Usage> };
	usage?: Partial<Usage>;
}

export interface MeterState {
	parent: Usage;
	/** One snapshot per settled subagent task, keyed by task id. */
	children: Map<string, Usage>;
	subagents: number;
	/** Output characters seen in the current parent response. */
	liveChars: number;
	/** When the current parent response started emitting, ms. */
	liveStartedAt?: number;
	/** Accumulated parent generation time, ms. Excludes the live response. */
	generationMs: number;
	/** Output tokens of responses whose generation time is in generationMs. */
	timedOutput: number;
}

export function createState(): MeterState {
	return {
		parent: emptyUsage(),
		children: new Map(),
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
 * (identical re-delivery is a no-op). Returns true when the totals changed.
 */
export function noteChild(state: MeterState, event: unknown): boolean {
	if (!event || typeof event !== "object") return false;
	const candidate = event as { taskId?: unknown; responses?: unknown };
	if (typeof candidate.taskId !== "string" || candidate.taskId.length === 0) return false;
	const usage: Partial<Usage> = {};
	let any = false;
	for (const field of TOKEN_FIELDS) {
		if (field === "reasoning" || field === "totalTokens") continue;
		const value = reported(candidate.responses, field);
		if (value > 0) {
			usage[field] = value;
			any = true;
		}
	}
	if (!any) return false;
	const snapshot: Usage = {
		input: usage.input ?? 0,
		output: usage.output ?? 0,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
	};
	if (sameUsage(state.children.get(candidate.taskId), snapshot)) return false;
	if (!state.children.has(candidate.taskId)) state.subagents += 1;
	state.children.set(candidate.taskId, snapshot);
	return true;
}

/** Drop one subagent task's tokens after a revocation. Returns true if it was stored. */
export function dropChild(state: MeterState, taskId: string): boolean {
	if (!state.children.delete(taskId)) return false;
	state.subagents -= 1;
	return true;
}

export interface Rates {
	live?: number;
	average?: number;
}

/** Live rate from streamed chars; session average from reported output / time. */
export function rates(state: MeterState, now: number, charsPerToken = 4): Rates {
	const liveMs = state.liveStartedAt === undefined ? 0 : Math.max(0, now - state.liveStartedAt);
	const live = liveMs >= 250 && state.liveChars > 0 ? (state.liveChars / charsPerToken) / (liveMs / 1000) : undefined;
	const average = state.generationMs >= 250 && state.timedOutput > 0
		? state.timedOutput / (state.generationMs / 1000)
		: undefined;
	return { live, average };
}

export function totals(state: MeterState): Usage {
	let total = state.parent;
	for (const child of state.children.values()) total = sumUsage(total, child);
	return { input: total.input, output: total.output, cacheRead: total.cacheRead, cacheWrite: total.cacheWrite };
}
