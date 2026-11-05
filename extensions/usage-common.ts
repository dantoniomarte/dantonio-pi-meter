/**
 * Shared contract for subscription usage sources, matching Gentle Shell's
 * usage-source event (gentle-pi:usage-source/v1). Every provider mapper in
 * this package translates one documented HTTP payload into ProviderUsageLike;
 * the shell validates the shape, resolves the provider's own API key from
 * Pi's auth store, and renders the panel. Mappers are pure and defensive:
 * they answer undefined instead of throwing, and never invent meters for
 * data the provider did not report.
 */

export const USAGE_SOURCE_EVENT = "gentle-pi:usage-source/v1";
export const USAGE_SOURCE_SCHEMA = "gentle-pi.usage-source/v1";

export interface UsageWindowLike {
	label: string;
	usedPercent: number;
	windowSeconds: number;
	resetAt: number | null;
}

export interface UsageLimitLike {
	name: string;
	windows: UsageWindowLike[];
	limitReached: boolean;
}

export interface ProviderUsageLike {
	provider: string;
	plan: string | undefined;
	limits: UsageLimitLike[];
	fetchedAt: number;
}

export interface UsageSourceEvents {
	emit(event: string, payload: unknown): void;
}

export type UsageSourceFetch = (
	apiKey: string | undefined,
	fetchFn: typeof fetch,
	now: number,
) => Promise<ProviderUsageLike | undefined>;

/** A non-negative finite number, else null — malformed fields become 0 upstream. */
export function finiteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

/** ISO 8601 string (or epoch milliseconds) to epoch milliseconds, else null. */
export function isoToMs(value: unknown): number | null {
	if (typeof value === "string") {
		const ms = Date.parse(value);
		return Number.isFinite(ms) ? ms : null;
	}
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return null;
}

/**
 * One Bearer-authenticated GET against a provider's usage endpoint, run
 * through the shell-supplied fetch. A missing key, HTTP failure, network
 * error or untranslatable body all answer undefined — never throw.
 */
export function bearerFetchSource(
	url: string,
	translate: (payload: unknown, now: number) => ProviderUsageLike | undefined,
): UsageSourceFetch {
	return async (apiKey, fetchFn, now) => {
		if (!apiKey) return undefined;
		try {
			const response = await fetchFn(url, { headers: { Authorization: `Bearer ${apiKey}` } });
			if (!response.ok) return undefined;
			return translate(await response.json(), now);
		} catch {
			return undefined;
		}
	};
}
