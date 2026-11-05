/**
 * OpenRouter usage source: GET https://openrouter.ai/api/v1/key with the
 * account's Bearer key. The documented response carries the key's own credit
 * limit (limit / limit_remaining), every enforced budget window
 * (spend_usd / limit_usd with resets_at), and all-time plus daily spend
 * totals. Limit and budget windows render as real meters; totals ride the
 * plan line, so an unlimited account still shows consumption as text.
 */

import {
	USAGE_SOURCE_EVENT,
	USAGE_SOURCE_SCHEMA,
	type ProviderUsageLike,
	type UsageLimitLike,
	type UsageSourceEvents,
	bearerFetchSource,
	clampPercent,
	finiteNumber,
	isoToMs,
} from "./usage-common.ts";

export const OPENROUTER_PROVIDER = "openrouter";
export const OPENROUTER_USAGE_URL = "https://openrouter.ai/api/v1/key";

function money(value: number): string {
	return `$${(Math.round(value * 100) / 100).toString()}`;
}

/** Translate one OpenRouter /api/v1/key payload into the shell's ProviderUsage. */
export function translateOpenrouterUsage(payload: unknown, now: number): ProviderUsageLike | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const raw = payload as Record<string, unknown>;
	if (!raw.data || typeof raw.data !== "object") return undefined;
	const data = raw.data as Record<string, unknown>;

	const limits: UsageLimitLike[] = [];
	const keyLimit = finiteNumber(data.limit) ? data.limit : null;
	const keyRemaining = finiteNumber(data.limit_remaining) ? data.limit_remaining : null;
	if (keyLimit !== null && keyLimit > 0 && keyRemaining !== null) {
		const usedPercent = clampPercent(((keyLimit - keyRemaining) / keyLimit) * 100);
		limits.push({
			name: "key",
			windows: [{ label: "key", usedPercent, windowSeconds: 0, resetAt: null }],
			limitReached: usedPercent >= 100,
		});
	}
	if (Array.isArray(data.budgets)) {
		for (const entry of data.budgets) {
			if (!entry || typeof entry !== "object") continue;
			const budget = entry as Record<string, unknown>;
			const limitUsd = finiteNumber(budget.limit_usd) ? budget.limit_usd : null;
			const spendUsd = finiteNumber(budget.spend_usd) ? budget.spend_usd : null;
			if (limitUsd === null || limitUsd <= 0 || spendUsd === null) continue;
			const usedPercent = clampPercent((spendUsd / limitUsd) * 100);
			const resetAt = isoToMs(budget.resets_at);
			const windowSeconds = resetAt === null ? 0 : Math.max(0, Math.round((resetAt - now) / 1000));
			limits.push({
				name: typeof budget.scope === "string" && budget.scope.length > 0 ? budget.scope : "budget",
				windows: [{ label: "spend", usedPercent, windowSeconds, resetAt }],
				limitReached: usedPercent >= 100,
			});
		}
	}

	const usage = finiteNumber(data.usage) ? data.usage : null;
	const usageDaily = finiteNumber(data.usage_daily) ? data.usage_daily : null;
	if (limits.length === 0 && usage === null && usageDaily === null) return undefined;
	const planParts: string[] = [OPENROUTER_PROVIDER];
	if (usage !== null) planParts.push(`${money(usage)} used`);
	if (usageDaily !== null) planParts.push(`${money(usageDaily)} today`);
	return { provider: OPENROUTER_PROVIDER, plan: planParts.join(" · "), limits, fetchedAt: now };
}

/** Register OpenRouter as a shell usage source. Safe to re-emit per session. */
export function registerOpenrouterUsageSource(events: UsageSourceEvents): void {
	events.emit(USAGE_SOURCE_EVENT, {
		schema: USAGE_SOURCE_SCHEMA,
		provider: OPENROUTER_PROVIDER,
		pendingNote: "no OpenRouter usage yet · r to fetch",
		fetch: bearerFetchSource(OPENROUTER_USAGE_URL, translateOpenrouterUsage),
	});
}
