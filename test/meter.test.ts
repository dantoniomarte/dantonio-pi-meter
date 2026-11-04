import assert from "node:assert/strict";
import test from "node:test";
import { compact, formatRate, renderLine, type Usage } from "../extensions/format.ts";
import {
	createState,
	dropChild,
	endParentResponse,
	foldEntries,
	noteChild,
	noteDelta,
	rates,
	totals,
} from "../extensions/state.ts";

const zero: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

test("compact keeps the line short and stable", () => {
	assert.equal(compact(0), "0");
	assert.equal(compact(999), "999");
	assert.equal(compact(1_234), "1.2k");
	assert.equal(compact(12_000), "12k");
	assert.equal(compact(12_300_000), "12.3M");
});

test("renderLine shows in as the full prompt volume, like /session-info", () => {
	// 12,400 uncached + 80,000 cached + 1,200 written = 93,600 prompt tokens.
	const line = renderLine({
		totals: { input: 12_400, output: 3_100, cacheRead: 80_000, cacheWrite: 1_200 },
		subagents: 2,
		live: 42,
		average: 31.2,
	});
	assert.equal(line.includes("\n"), false);
	assert.match(line, /in 93\.6k/);
	assert.match(line, /out 3\.1k/);
	assert.match(line, /cacheR 80k/);
	assert.match(line, /cacheW 1\.2k/);
	assert.match(line, /42 tok\/s/);
	assert.match(line, /avg 31\.2/);
	assert.match(line, /\+2 sa/);
});

test("in reconciles with the real session's /session-info Input", () => {
	// Session 01a1867c: uncached 24,455,696 + cached 140,414,720 + written 0
	// must render as the Input the session-info panel prints.
	const line = renderLine({
		totals: { input: 24_455_696, output: 297_856, cacheRead: 140_414_720, cacheWrite: 0 },
		subagents: 0,
	});
	assert.match(line, /in 164\.9M/);
	assert.match(line, /out 297\.9k/);
	assert.match(line, /cacheR 140\.4M/);
});

test("idle line uses a dash instead of a fake zero rate", () => {
	assert.equal(formatRate(undefined), "–");
	const line = renderLine({ totals: zero, subagents: 0 });
	assert.match(line, /– tok\/s · avg –/);
	assert.equal(line.includes("+"), false);
});

test("parent usage and generation time produce the session average", () => {
	const state = createState();
	noteDelta(state, 400, 1_000);
	endParentResponse(state, { input: 1000, output: 100, cacheRead: 50, cacheWrite: 10 }, 3_000);
	assert.equal(state.parent.output, 100);
	assert.equal(state.generationMs, 2_000);
	assert.equal(rates(state, 9_000).average, 50);
	assert.equal(rates(state, 9_000).live, undefined);
});

test("live rate uses streamed characters only while a response is open", () => {
	const state = createState();
	noteDelta(state, 800, 1_000);
	const live = rates(state, 2_000).live;
	assert.ok(live && live > 0);
	endParentResponse(state, { output: 10 }, 2_000);
	assert.equal(rates(state, 5_000).live, undefined);
});

function childEvent(taskId: string, tokens: Record<string, unknown>): { taskId: string; responses: unknown[] } {
	return { taskId, responses: [{ tokens }] };
}

test("a repeated child snapshot replaces the stored one instead of skipping", () => {
	const state = createState();
	const first = childEvent("task-1", {
		input: { state: "reported", value: 500 },
		output: { state: "reported", value: 40 },
		cacheRead: { state: "unavailable" },
		cacheWrite: { state: "reported", value: 8 },
	});
	assert.equal(noteChild(state, first), true);
	assert.equal(noteChild(state, first), false); // identical re-delivery: nothing changed
	assert.deepEqual(totals(state), { input: 500, output: 40, cacheRead: 0, cacheWrite: 8 });
	assert.equal(state.subagents, 1);

	const second = childEvent("task-1", {
		input: { state: "reported", value: 900 },
		output: { state: "reported", value: 60 },
		cacheRead: { state: "reported", value: 1000 },
		cacheWrite: { state: "unavailable" },
	});
	assert.equal(noteChild(state, second), true); // fresher snapshot wins
	assert.deepEqual(totals(state), { input: 900, output: 60, cacheRead: 1000, cacheWrite: 0 });
	assert.equal(state.subagents, 1);
});

test("malformed or empty child snapshots are ignored", () => {
	const state = createState();
	assert.equal(noteChild(state, { taskId: "" }), false);
	assert.equal(noteChild(state, null), false);
	assert.equal(noteChild(state, childEvent("task-x", {
		input: { state: "unavailable" },
		output: { state: "unavailable" },
		cacheRead: { state: "unavailable" },
		cacheWrite: { state: "unavailable" },
	})), false);
	assert.equal(state.subagents, 0);
	assert.deepEqual(totals(state), zero);
});

test("a second task folds alongside the first", () => {
	const state = createState();
	noteChild(state, childEvent("task-1", { input: { state: "reported", value: 100 } }));
	noteChild(state, childEvent("task-2", { output: { state: "reported", value: 20 } }));
	assert.equal(state.subagents, 2);
	assert.deepEqual(totals(state), { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 });
});

test("dropChild removes a revoked subagent from the totals", () => {
	const state = createState();
	noteChild(state, childEvent("task-1", { input: { state: "reported", value: 500 } }));
	noteChild(state, childEvent("task-2", { output: { state: "reported", value: 40 } }));
	assert.equal(dropChild(state, "task-1"), true);
	assert.deepEqual(totals(state), { input: 0, output: 40, cacheRead: 0, cacheWrite: 0 });
	assert.equal(state.subagents, 1);
	assert.equal(dropChild(state, "task-1"), false); // already gone
	assert.equal(dropChild(state, "never-seen"), false);
});

test("a child's wall time feeds the subagent task throughput", () => {
	const state = createState();
	// Task 1: 600 output tokens over 3,000 ms of wall time -> 200 tok/s.
	noteChild(state, childEvent("task-1", { output: { state: "reported", value: 600 } }), 5_000, 2_000);
	// Task 2: 240 output tokens over 2,000 ms -> 120 tok/s. Aggregate:
	// 840 tokens / 5,000 ms = 168 tok/s (total over total, not the mean).
	noteChild(state, childEvent("task-2", { output: { state: "reported", value: 240 } }), 4_000, 2_000);
	assert.equal(state.subagentMs, 5_000);
	assert.equal(rates(state, 0).subagent, 168);
});

test("subagent throughput drops with the revoked task's tokens and time", () => {
	const state = createState();
	noteChild(state, childEvent("task-1", { output: { state: "reported", value: 600 } }), 5_000, 2_000);
	noteChild(state, childEvent("task-2", { output: { state: "reported", value: 240 } }), 4_000, 2_000);
	assert.equal(dropChild(state, "task-1"), true);
	assert.equal(state.subagentMs, 2_000);
	assert.equal(rates(state, 0).subagent, 120);
});

test("a replacement snapshot replaces wall time instead of stacking it", () => {
	const state = createState();
	noteChild(state, childEvent("task-1", { output: { state: "reported", value: 600 } }), 5_000, 2_000);
	// Re-delivery with a fresh settledAt and more tokens: the stored window is
	// replaced, never added to (stacking would make subagentMs 6,000).
	noteChild(state, childEvent("task-1", { output: { state: "reported", value: 900 } }), 9_000, 6_000);
	assert.equal(state.subagentMs, 3_000);
	assert.equal(rates(state, 0).subagent, 300);
});

test("subagent throughput is undefined without settled tasks or wall time", () => {
	const state = createState();
	assert.equal(rates(state, 0).subagent, undefined);
	// A degenerate window (settle at launch, or settle before launch) stores no
	// time, so the rate stays undefined even with tokens present.
	noteChild(state, childEvent("task-1", { output: { state: "reported", value: 600 } }), 5_000, 5_000);
	assert.equal(state.subagentMs, 0);
	noteChild(state, childEvent("task-2", { output: { state: "reported", value: 600 } }), 4_000, 5_000);
	assert.equal(rates(state, 0).subagent, undefined);
});

test("renderLine shows subagent throughput beside the count marker", () => {
	const line = renderLine({ totals: zero, subagents: 2, subagentRate: 14.2 });
	assert.match(line, /\+2 sa @14\.2/);
	// Count-only stays in the old shape.
	const countOnly = renderLine({ totals: zero, subagents: 2 });
	assert.match(countOnly, /\+2 sa$/);
	assert.equal(countOnly.includes("@"), false);
});

test("foldEntries seeds parent totals from a resumed session's entries", () => {
	const state = createState();
	const entries: unknown[] = [
		{ type: "session", id: "s1" },
		{ type: "model_change", provider: "example", modelId: "m" },
		{ type: "custom", customType: "gentle-agents.result" },
		{ type: "message", message: { role: "user", content: "hi" } },
		{ type: "message", message: { role: "assistant", usage: { input: 100, output: 10, cacheRead: 200, cacheWrite: 0 } } },
		{ type: "message", message: { role: "assistant", content: "no usage here" } },
		{ type: "usage", provider: "example", model: "m", usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 } },
		{ type: "message", message: { role: "toolResult", usage: { input: 7, output: 0, cacheRead: 0, cacheWrite: 0 } } },
		{ type: "compaction", summary: "s", usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0 } },
		{ type: "branch_summary", usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } },
	];
	const folded = foldEntries(state, entries);
	assert.equal(folded, 5);
	assert.deepEqual(state.parent, { input: 116, output: 13, cacheRead: 200, cacheWrite: 0 });
	assert.equal(state.subagents, 0);
});

test("foldEntries tolerates malformed entries", () => {
	const state = createState();
	assert.equal(foldEntries(state, undefined as unknown as unknown[]), 0);
	assert.equal(foldEntries(state, [null, 42, "nope"] as unknown as unknown[]), 0);
	assert.deepEqual(state.parent, zero);
});
