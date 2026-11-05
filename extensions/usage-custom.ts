/**
 * User-defined custom usage providers. Users declare extra usage sources in
 * settings under the `dantonio-pi-meter` key, reusing one of the mappers
 * this package ships:
 *
 * ```json
 * "dantonio-pi-meter": {
 *   "usageProviders": [
 *     { "provider": "myrouter", "url": "https://api.myrouter.com/api/v1/key",
 *       "style": "openrouter" },
 *     { "provider": "gw", "url": "https://gw.example.org/v1/usage?days=7",
 *       "style": "usage_summary" }
 *   ]
 * }
 * ```
 *
 * `provider` must match the session's provider id (that is how the shell
 * resolves the API key and decides to list the row). Every entry is
 * validated defensively: malformed entries are dropped, never fatal.
 */

import {
	USAGE_SOURCE_EVENT,
	USAGE_SOURCE_SCHEMA,
	type UsageSourceEvents,
	bearerFetchSource,
} from "./usage-common.ts";
import { translateOpencodeUsage } from "./usage-opencode.ts";
import { translateOpenrouterUsage } from "./usage-openrouter.ts";
import { translateTorogozUsage } from "./usage-torogoz.ts";

export type CustomUsageStyle = "openrouter" | "usage_summary" | "opencode-go";

export interface CustomUsageProviderConfig {
	provider: string;
	url: string;
	style: CustomUsageStyle;
}

const STYLES: Record<CustomUsageStyle, (payload: unknown, now: number) => ReturnType<typeof translateTorogozUsage>> = {
	openrouter: translateOpenrouterUsage,
	usage_summary: translateTorogozUsage,
	"opencode-go": translateOpencodeUsage,
};

function isHttpUrl(value: unknown): value is string {
	return typeof value === "string" && /^https?:\/\/[^\s]+$/i.test(value) && value.length <= 2048;
}

/** Parse and validate the settings blob; malformed entries are dropped. */
export function customUsageProviders(raw: unknown): CustomUsageProviderConfig[] {
	if (!raw || typeof raw !== "object") return [];
	const providers = (raw as Record<string, unknown>).usageProviders;
	if (!Array.isArray(providers)) return [];
	const seen = new Set<string>();
	const parsed: CustomUsageProviderConfig[] = [];
	for (const entry of providers) {
		if (!entry || typeof entry !== "object") continue;
		const row = entry as Record<string, unknown>;
		if (typeof row.provider !== "string" || row.provider.length === 0 || row.provider.length > 64) continue;
		if (!isHttpUrl(row.url)) continue;
		if (typeof row.style !== "string" || !(row.style in STYLES)) continue;
		if (seen.has(row.provider)) continue;
		seen.add(row.provider);
		parsed.push({ provider: row.provider, url: row.url, style: row.style as CustomUsageStyle });
	}
	return parsed;
}

/** Register every valid custom entry as a bearer usage source. */
export function registerCustomUsageSources(events: UsageSourceEvents, config: CustomUsageProviderConfig[]): void {
	for (const entry of config) {
		const translate = STYLES[entry.style];
		events.emit(USAGE_SOURCE_EVENT, {
			schema: USAGE_SOURCE_SCHEMA,
			provider: entry.provider,
			pendingNote: `no ${entry.provider} usage yet · r to fetch`,
			fetch: bearerFetchSource(entry.url, translate),
		});
	}
}
