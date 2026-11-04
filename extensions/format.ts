/** Pure formatting for the one-line meter. No terminal, no timers. */

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function addUsage(into: Usage, from: Partial<Usage> | null | undefined): void {
	if (!from) return;
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		const value = from[key];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) into[key] += value;
	}
}

export function sumUsage(a: Usage, b: Usage): Usage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
	};
}

/** 999 -> "999", 1234 -> "1.2k", 12_300_000 -> "12.3M". */
export function compact(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value >= 1_000_000) return `${trim((value / 1_000_000).toFixed(1))}M`;
	if (value >= 1_000) return `${trim((value / 1_000).toFixed(1))}k`;
	return String(Math.round(value));
}

function trim(text: string): string {
	return text.endsWith(".0") ? text.slice(0, -2) : text;
}

export function formatRate(tokensPerSecond: number | undefined): string {
	if (tokensPerSecond === undefined || !Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return "–";
	if (tokensPerSecond >= 100) return String(Math.round(tokensPerSecond));
	return trim(tokensPerSecond.toFixed(1));
}

export interface MeterView {
	totals: Usage;
	/** Subagent tasks already folded into totals. */
	subagents: number;
	/** Live decode rate of the current parent response, if streaming. */
	live?: number;
	/** Session average: total output tokens / measured generation seconds. */
	average?: number;
}

/**
 * One line, dim, stable width for a given set of numbers.
 * Example: `in 93.6k · out 3.1k · cacheR 80k · cacheW 1.2k · 42 tok/s · avg 31 · +2 sa`
 *
 * `in` is the full prompt volume (uncached + cacheRead + cacheWrite), the same
 * number /session-info prints as Input; cacheR/cacheW are its cached split.
 */
export function renderLine(view: MeterView): string {
	const { totals } = view;
	const promptVolume = totals.input + totals.cacheRead + totals.cacheWrite;
	const parts = [
		`in ${compact(promptVolume)}`,
		`out ${compact(totals.output)}`,
		`cacheR ${compact(totals.cacheRead)}`,
		`cacheW ${compact(totals.cacheWrite)}`,
		`${formatRate(view.live)} tok/s`,
		`avg ${formatRate(view.average)}`,
	];
	if (view.subagents > 0) parts.push(`+${view.subagents} sa`);
	return parts.join(" · ");
}
