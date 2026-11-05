/**
 * OpenCode Go usage source: GET https://opencode.ai/zen/go/v1/usage with the
 * account's Bearer key. The endpoint reports three quota windows (rolling
 * 5-hour, weekly, monthly), each as a used percentage with an absolute reset
 * timestamp or a seconds-until-reset. Field aliases match the reference
 * community bridge, so older and newer payload shapes both parse.
 */

import {
	USAGE_SOURCE_EVENT,
	USAGE_SOURCE_SCHEMA,
	type ProviderUsageLike,
	type UsageLimitLike,
	type UsageSourceEvents,
	type UsageWindowLike,
	bearerFetchSource,
	clampPercent,
	finiteNumber,
	isoToMs,
} from "./usage-common.ts";

export const OPENCODE_PROVIDER = "opencode";
export const OPENCODE_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

const WINDOWS: Array<{ key: string; label: string }> = [
	{ key: "rolling", label: "5h" },
	{ key: "weekly", label: "week" },
	{ key: "monthly", label: "month" },
];

function windowFrom(record: Record<string, unknown>, label: string, now: number): UsageWindowLike | undefined {
	// Like the reference bridge, any finite percent (including malformed
	// negatives) clamps into [0, 100]; only an absent percent drops the row.
	const rawPercent = typeof record.percent === "number" && Number.isFinite(record.percent) ? record.percent
		: typeof record.usagePercent === "number" && Number.isFinite(record.usagePercent) ? record.usagePercent
		: undefined;
	if (rawPercent === undefined) return undefined;
	const usedPercent = clampPercent(rawPercent);
	const resetAt = isoToMs(record.resetsAt ?? record.resetAt)
		?? (finiteNumber(record.resetsInSeconds) ? now + record.resetsInSeconds * 1000 : null)
		?? (finiteNumber(record.resetAfterSeconds) ? now + record.resetAfterSeconds * 1000 : null);
	const windowSeconds = resetAt === null ? 0 : Math.max(0, Math.round((resetAt - now) / 1000));
	return { label, usedPercent, windowSeconds, resetAt };
}

/** Translate one OpenCode Go usage payload into the shell's ProviderUsage. */
export function translateOpencodeUsage(payload: unknown, now: number): ProviderUsageLike | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const raw = payload as Record<string, unknown>;
	const usage = raw.usage && typeof raw.usage === "object"
		? (raw.usage as Record<string, unknown>)
		: raw;
	const windows: UsageWindowLike[] = [];
	for (const { key, label } of WINDOWS) {
		const entry = usage[key];
		if (!entry || typeof entry !== "object") continue;
		const window = windowFrom(entry as Record<string, unknown>, label, now);
		if (window) windows.push(window);
	}
	if (windows.length === 0) return undefined;
	const name = typeof raw.label === "string" && raw.label.length > 0 ? raw.label : "OpenCode Go";
	const limit: UsageLimitLike = {
		name,
		windows,
		limitReached: windows.some((w) => w.usedPercent >= 100),
	};
	return { provider: OPENCODE_PROVIDER, plan: name, limits: [limit], fetchedAt: now };
}

/** Register OpenCode Go as a shell usage source. Safe to re-emit per session. */
export function registerOpencodeUsageSource(events: UsageSourceEvents): void {
	events.emit(USAGE_SOURCE_EVENT, {
		schema: USAGE_SOURCE_SCHEMA,
		provider: OPENCODE_PROVIDER,
		pendingNote: "no OpenCode usage yet · r to fetch",
		fetch: bearerFetchSource(OPENCODE_USAGE_URL, translateOpencodeUsage),
	});
}
