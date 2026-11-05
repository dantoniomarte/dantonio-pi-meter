/**
 * Usage source registry: registers every subscription usage adapter this
 * package ships. Each source is inert unless the session targets its
 * provider (the active provider or one named by the active profile's
 * subagent routing); registration is safe to re-emit per session because
 * the shell replaces a prior registration for the same provider.
 */

import { registerOpencodeUsageSource } from "./usage-opencode.ts";
import { registerOpenrouterUsageSource } from "./usage-openrouter.ts";
import { registerTorogozUsageSource } from "./usage-torogoz.ts";
import type { UsageSourceEvents } from "./usage-common.ts";

export function registerUsageSources(events: UsageSourceEvents): void {
	registerTorogozUsageSource(events);
	registerOpencodeUsageSource(events);
	registerOpenrouterUsageSource(events);
}
