import assert from "node:assert/strict";
import test from "node:test";
import {
	USAGE_SOURCE_EVENT,
	USAGE_SOURCE_SCHEMA,
} from "../extensions/usage-common.ts";
import {
	OPENCODE_USAGE_URL,
	registerOpencodeUsageSource,
	translateOpencodeUsage,
} from "../extensions/usage-opencode.ts";
import {
	OPENROUTER_USAGE_URL,
	registerOpenrouterUsageSource,
	translateOpenrouterUsage,
} from "../extensions/usage-openrouter.ts";
import {
	TOROGOZ_USAGE_URL,
	registerTorogozUsageSource,
	translateTorogozUsage,
} from "../extensions/usage-torogoz.ts";
import { registerUsageSources } from "../extensions/usage-registry.ts";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// torogoz (ported from the private usage-source tests)
// ---------------------------------------------------------------------------

const summary = (quotas: unknown[], plan: unknown = null) => ({
	object: "usage_summary",
	user: "root",
	window_days: 7,
	totals: { requests: 1204, prompt_tokens: 150_000_000, completion_tokens: 2_677_883, quota: 15_859_183 },
	plan,
	quotas,
});

test("torogoz: unlimited payload shows totals on the plan line and no fake meters", () => {
	const usage = translateTorogozUsage(summary([
		{ model: "grok-4.7", allowance: "unlimited", limit_tokens: null, used_tokens: 145_508_102, remaining_tokens: null, period_end: "2026-11-20" },
	]), NOW);
	assert.ok(usage);
	assert.equal(usage.provider, "torogoz");
	assert.equal(usage.limits.length, 0);
	assert.match(usage.plan!, /root · 7d 152\.7M tok · 1\.2k req/);
});

test("torogoz: limited quota rows become real metered windows with reset", () => {
	const usage = translateTorogozUsage(summary([
		{ model: "glm-5.3-flash", allowance: "limited", limit_tokens: 1_000_000, used_tokens: 250_000, limit_requests: 500, used_requests: 100, period_end: "2026-11-20" },
	]), NOW);
	assert.ok(usage);
	assert.equal(usage.limits.length, 1);
	const limit = usage.limits[0];
	assert.equal(limit.name, "glm-5.3-flash");
	assert.equal(limit.windows.length, 2);
	assert.equal(limit.windows[0].label, "");
	assert.equal(limit.windows[0].usedPercent, 25);
	assert.equal(limit.windows[1].label, "req");
	assert.equal(limit.windows[1].usedPercent, 20);
	assert.equal(limit.windows[0].resetAt, Date.parse("2026-11-20T00:00:00Z"));
	assert.ok(Math.abs(limit.windows[0].windowSeconds - (limit.windows[0].resetAt! - NOW) / 1000) < 2);
});

test("torogoz: unconfigured and malformed rows are skipped, plan name rides through", () => {
	const usage = translateTorogozUsage(summary([
		{ model: "qwen3.8-27b", allowance: "unconfigured", limit_tokens: null, used_tokens: 216, period_end: "2026-11-20" },
		{ model: "broken", allowance: "limited" },
		"not-an-object",
	], "basic"), NOW);
	assert.ok(usage);
	assert.equal(usage.limits.length, 0);
	assert.match(usage.plan!, /^basic · /);
});

test("torogoz: foreign or truncated payloads answer undefined, never throw", () => {
	assert.equal(translateTorogozUsage(null, NOW), undefined);
	assert.equal(translateTorogozUsage({}, NOW), undefined);
	assert.equal(translateTorogozUsage({ object: "other" }, NOW), undefined);
	assert.equal(translateTorogozUsage("junk", NOW), undefined);
});

// ---------------------------------------------------------------------------
// opencode (GET https://opencode.ai/zen/go/v1/usage)
// ---------------------------------------------------------------------------

test("opencode: documented rolling/weekly/monthly windows become metered rows", () => {
	const payload = {
		usage: {
			rolling: { percent: 40, resetsAt: "2026-10-27T17:00:00.000Z" },
			weekly: { percent: 10, resetsInSeconds: 3600 },
			monthly: { percent: 100, status: "ok" },
		},
	};
	const usage = translateOpencodeUsage(payload, NOW);
	assert.ok(usage);
	assert.equal(usage.provider, "opencode");
	assert.equal(usage.limits.length, 1);
	const limit = usage.limits[0];
	assert.equal(limit.windows.length, 3);
	assert.equal(limit.windows[0].label, "5h");
	assert.equal(limit.windows[0].usedPercent, 40);
	assert.equal(limit.windows[0].resetAt, Date.parse("2026-10-27T17:00:00.000Z"));
	assert.equal(limit.windows[1].label, "week");
	assert.equal(limit.windows[1].resetAt, NOW + 3600 * 1000);
	assert.equal(limit.windows[2].label, "month");
	assert.equal(limit.windows[2].resetAt, null);
	assert.equal(limit.limitReached, true);
});

test("opencode: legacy field aliases are accepted like the reference bridge", () => {
	const usage = translateOpencodeUsage({
		usage: { rolling: { usagePercent: 55, resetAfterSeconds: 600 } },
	}, NOW);
	assert.ok(usage);
	assert.equal(usage.limits[0].windows[0].usedPercent, 55);
	assert.equal(usage.limits[0].windows[0].resetAt, NOW + 600 * 1000);
});

test("opencode: percent is clamped and missing percent rows are skipped", () => {
	const usage = translateOpencodeUsage({
		usage: { rolling: { percent: 250 }, weekly: { status: "ok" }, monthly: { percent: -5 } },
	}, NOW);
	assert.ok(usage);
	assert.equal(usage.limits[0].windows.length, 2);
	assert.equal(usage.limits[0].windows[0].usedPercent, 100);
	assert.equal(usage.limits[0].windows[1].usedPercent, 0);
});

test("opencode: payloads without any usable window answer undefined", () => {
	assert.equal(translateOpencodeUsage(null, NOW), undefined);
	assert.equal(translateOpencodeUsage({}, NOW), undefined);
	assert.equal(translateOpencodeUsage({ usage: {} }, NOW), undefined);
	assert.equal(translateOpencodeUsage({ usage: { rolling: { status: "ok" } } }, NOW), undefined);
});

// ---------------------------------------------------------------------------
// openrouter (GET https://openrouter.ai/api/v1/key)
// ---------------------------------------------------------------------------

test("openrouter: the key credit limit becomes a metered window", () => {
	const usage = translateOpenrouterUsage({
		data: { limit: 100, limit_remaining: 25, limit_reset: "monthly", usage: 75, usage_daily: 2.5 },
	}, NOW);
	assert.ok(usage);
	assert.equal(usage.provider, "openrouter");
	assert.equal(usage.limits.length, 1);
	assert.equal(usage.limits[0].name, "key");
	assert.equal(usage.limits[0].windows[0].usedPercent, 75);
	assert.equal(usage.limits[0].windows[0].resetAt, null);
});

test("openrouter: budgets become metered windows with reset instants", () => {
	const usage = translateOpenrouterUsage({
		data: {
			limit: null,
			usage: 40,
			budgets: [
				{ scope: "member", limit_usd: 50, spend_usd: 40, remaining_usd: 10, resets_at: "2026-11-01T00:00:00.000Z" },
				{ scope: "workspace", limit_usd: 200, spend_usd: 30, remaining_usd: 170, resets_at: null },
			],
		},
	}, NOW);
	assert.ok(usage);
	assert.equal(usage.limits.length, 2);
	assert.equal(usage.limits[0].name, "member");
	assert.equal(usage.limits[0].windows[0].usedPercent, 80);
	assert.equal(usage.limits[0].windows[0].resetAt, Date.parse("2026-11-01T00:00:00.000Z"));
	assert.ok(Math.abs(usage.limits[0].windows[0].windowSeconds - (usage.limits[0].windows[0].resetAt! - NOW) / 1000) < 2);
	assert.equal(usage.limits[1].name, "workspace");
	assert.equal(usage.limits[1].windows[0].usedPercent, 15);
	assert.equal(usage.limits[1].windows[0].resetAt, null);
});

test("openrouter: spend totals ride the plan line for unlimited accounts", () => {
	const usage = translateOpenrouterUsage({ data: { limit: null, usage: 12.34, usage_daily: 0.56 } }, NOW);
	assert.ok(usage);
	assert.equal(usage.limits.length, 0);
	assert.equal(usage.plan, "openrouter · $12.34 used · $0.56 today");
});

test("openrouter: payloads without any data answer undefined, never throw", () => {
	assert.equal(translateOpenrouterUsage(null, NOW), undefined);
	assert.equal(translateOpenrouterUsage({}, NOW), undefined);
	assert.equal(translateOpenrouterUsage({ data: "junk" }, NOW), undefined);
});

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

test("registerUsageSources registers torogoz, opencode and openrouter exactly once", () => {
	const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
	registerUsageSources({ emit: (event, payload) => emitted.push({ event, payload: payload as Record<string, unknown> }) });
	assert.equal(emitted.length, 3);
	assert.deepEqual(emitted.map((e) => e.payload.provider), ["torogoz", "opencode", "openrouter"]);
	for (const { event, payload } of emitted) {
		assert.equal(event, USAGE_SOURCE_EVENT);
		assert.equal(payload.schema, USAGE_SOURCE_SCHEMA);
		assert.equal(typeof payload.fetch, "function");
	}
	assert.equal(USAGE_SOURCE_EVENT, "gentle-pi:usage-source/v1");
	assert.equal(USAGE_SOURCE_SCHEMA, "gentle-pi.usage-source/v1");
});

test("every source fetch answers undefined without a key, on HTTP failure and on junk", async () => {
	const sources: Record<string, (apiKey: string | undefined, fetchFn: typeof fetch, now: number) => Promise<unknown>> = {};
	const emit = (event: string, payload: { provider: string; fetch: never }) => {
		if (event === USAGE_SOURCE_EVENT) sources[payload.provider] = payload.fetch;
	};
	registerTorogozUsageSource({ emit: emit as never });
	registerOpencodeUsageSource({ emit: emit as never });
	registerOpenrouterUsageSource({ emit: emit as never });

	const okFetch = (url: unknown) => Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
	const badFetch = () => Promise.resolve(new Response("nope", { status: 401 }));

	for (const [provider, fetchSource] of Object.entries(sources)) {
		assert.equal(await fetchSource(undefined, badFetch, NOW), undefined, provider);
		assert.equal(await fetchSource("k", badFetch, NOW), undefined, provider);
		assert.equal(await fetchSource("k", okFetch as typeof fetch, NOW), undefined, provider);
	}
	assert.ok(sources.torogoz);
	assert.ok(sources.opencode);
	assert.ok(sources.openrouter);
});

test("a source fetch translates a live provider response", async () => {
	let calledUrl = "";
	let calledAuth = "";
	const fetchFn = ((url: unknown, init?: { headers?: Record<string, string> }) => {
		calledUrl = String(url);
		calledAuth = init?.headers?.Authorization ?? "";
		return Promise.resolve(new Response(JSON.stringify({
			usage: { rolling: { percent: 12, resetsAt: "2026-10-27T17:00:00.000Z" } },
		}), { status: 200 }));
	}) as typeof fetch;

	const emitted: Array<{ provider: string; fetch: (apiKey: string | undefined, fetchFn: typeof fetch, now: number) => Promise<unknown> }> = [];
	registerOpencodeUsageSource({
		emit: (_event, payload) => emitted.push(payload as { provider: string; fetch: (apiKey: string | undefined, fetchFn: typeof fetch, now: number) => Promise<unknown> }),
	});
	const usage = await emitted[0].fetch("sk-test", fetchFn, NOW);
	assert.ok(usage);
	assert.equal(usage.provider, "opencode");
	assert.equal(calledUrl, OPENCODE_USAGE_URL);
	assert.equal(calledAuth, "Bearer sk-test");
});
