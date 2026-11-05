/**
 * Torogoz usage source: GET /v1/usage (usage_summary payload). The plan line
 * carries the 7-day totals the panel cannot meter, and every limited model
 * quota becomes a real metered window with the period-end reset. Unlimited
 * plans stay visible as consumption text instead of a lying 0%.
 */

import { compact } from "./format.ts";
import {
	USAGE_SOURCE_EVENT,
	USAGE_SOURCE_SCHEMA,
	type UsageLimitLike,
	type UsageSourceEvents,
	type UsageSourceFetch,
	type UsageWindowLike,
	bearerFetchSource,
	finiteNumber,
} from "./usage-common.ts";

export const TOROGOZ_PROVIDER = "torogoz";
export const TOROGOZ_USAGE_URL = "https://api.torogozrouter.com/v1/usage?days=7";
const USAGE_DAYS = 7;

/** Period end is an exclusive YYYY-MM-DD boundary; reset lands at its UTC midnight. */
function periodEndMs(value: unknown): number | null {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	const ms = Date.parse(`${value}T00:00:00Z`);
	return Number.isFinite(ms) ? ms : null;
}

function quotaWindows(row: Record<string, unknown>, now: number): UsageWindowLike[] {
	const windows: UsageWindowLike[] = [];
	const resetAt = periodEndMs(row.period_end);
	const windowSeconds = resetAt === null ? 0 : Math.max(0, Math.round((resetAt - now) / 1000));
	const tokens = { used: row.used_tokens, limit: row.limit_tokens };
	if (finiteNumber(tokens.used) && finiteNumber(tokens.limit) && tokens.limit > 0) {
		windows.push({ label: "", usedPercent: (tokens.used / tokens.limit) * 100, windowSeconds, resetAt });
	}
	const requests = { used: row.used_requests, limit: row.limit_requests };
	if (finiteNumber(requests.used) && finiteNumber(requests.limit) && requests.limit > 0) {
		windows.push({ label: "req", usedPercent: (requests.used / requests.limit) * 100, windowSeconds, resetAt });
	}
	return windows;
}

/** Translate one torogoz /v1/usage payload into the shell's ProviderUsage. */
export function translateTorogozUsage(payload: unknown, now: number): ProviderUsageLike | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const raw = payload as Record<string, unknown>;
	if (raw.object !== "usage_summary") return undefined;
	const totals = (raw.totals ?? {}) as Record<string, unknown>;
	const tokens = (finiteNumber(totals.prompt_tokens) ? totals.prompt_tokens : 0)
		+ (finiteNumber(totals.completion_tokens) ? totals.completion_tokens : 0);
	const requests = finiteNumber(totals.requests) ? totals.requests : 0;
	const days = finiteNumber(raw.window_days) ? raw.window_days : USAGE_DAYS;
	// Plan line carries the totals the panel cannot meter: a real plan name
	// when the payload has one, else the account user, else the provider id.
	const base = typeof raw.plan === "string" && raw.plan.length > 0 ? raw.plan
		: typeof raw.user === "string" && raw.user.length > 0 ? raw.user
		: TOROGOZ_PROVIDER;
	const plan = `${base} · ${days}d ${compact(tokens)} tok · ${compact(requests)} req`;

	const limits: UsageLimitLike[] = [];
	if (Array.isArray(raw.quotas)) {
		for (const entry of raw.quotas) {
			if (!entry || typeof entry !== "object") continue;
			const row = entry as Record<string, unknown>;
			if (row.allowance !== "limited" || typeof row.model !== "string" || row.model.length === 0) continue;
			const windows = quotaWindows(row, now);
			if (windows.length === 0) continue;
			limits.push({ name: row.model, windows, limitReached: windows.some((w) => w.usedPercent >= 100) });
		}
	}
	return { provider: TOROGOZ_PROVIDER, plan, limits, fetchedAt: now };
}

/** Register torogoz as a shell usage source. Safe to re-emit per session. */
export function registerTorogozUsageSource(events: UsageSourceEvents): void {
	const fetch: UsageSourceFetch = bearerFetchSource(TOROGOZ_USAGE_URL, translateTorogozUsage);
	events.emit(USAGE_SOURCE_EVENT, {
		schema: USAGE_SOURCE_SCHEMA,
		provider: TOROGOZ_PROVIDER,
		pendingNote: "no torogoz usage yet · r to fetch",
		fetch,
	});
}
