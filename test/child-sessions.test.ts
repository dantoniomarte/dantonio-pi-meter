import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseTimedMessages, readChildTiming, resolveAgentHome, type ChildTiming } from "../extensions/child-sessions.ts";
import { applyChildSnapshot, createState, dropChild, endParentResponse, foldChildEntries, noteChild, noteDelta, rates, totals } from "../extensions/state.ts";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// --- JSONL parsing (pure) ---------------------------------------------------
// Real shape observed in child sessions: one JSON object per line, assistant
// entries carry message.usage.output and message.durationMs (ms). Entries with
// stopReason "error" report output 0 and count nothing through the output > 0
// rule — no special-casing.

function assistantLine(output: number, durationMs: number): string {
	return JSON.stringify({
		type: "message",
		id: "m1",
		parentId: "p1",
		timestamp: "2026-10-27T02:54:24.561Z",
		message: { role: "assistant", content: [], usage: { output }, durationMs, stopReason: "stop" },
	});
}

test("parseTimedMessages sums output over duration from timed assistant entries", () => {
	const jsonl = [
		JSON.stringify({ type: "session", id: "s1" }),
		JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
		assistantLine(100, 2_000),
		assistantLine(50, 1_000),
		JSON.stringify({ type: "message", message: { role: "toolResult", usage: { output: 0 }, durationMs: 5_000 } }),
		"not json",
		"",
	].join("\n");
	assert.deepEqual(parseTimedMessages(jsonl), { generationMs: 3_000, timedOutput: 150 });
});

test("parseTimedMessages ignores untimed or degenerate assistant entries", () => {
	const jsonl = [
		assistantLine(100, 2_000), // timed: counts
		JSON.stringify({ type: "message", message: { role: "assistant", usage: { output: 80 } } }), // legacy, no durationMs
		assistantLine(40, Number.NaN), // non-finite duration
		assistantLine(20, -5), // negative duration
		assistantLine(0, 900), // zero output contributes nothing
	].join("\n");
	assert.deepEqual(parseTimedMessages(jsonl), { generationMs: 2_000, timedOutput: 100 });
});

test("parseTimedMessages returns zeros for empty input", () => {
	assert.deepEqual(parseTimedMessages(""), { generationMs: 0, timedOutput: 0 });
});

// --- per-child timing fold (state) ------------------------------------------

function childUsageEvent(taskId: string, usage: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number }>): { taskId: string; responses: unknown[] } {
	const tokens: Record<string, unknown> = {};
	for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		tokens[field] = usage[field] !== undefined ? { state: "reported", value: usage[field] } : { state: "unavailable" };
	}
	return { taskId, responses: [{ tokens }] };
}

function childEntry(taskId: string, data: Record<string, unknown>): unknown {
	return { type: "custom", customType: "dantonio-pi-meter:child-usage/v1", data: { taskId, ...data } };
}

test("a child's generation timing feeds the combined session average", () => {
	const state = createState();
	// Parent: 2,000 ms / 100 tokens -> parent-only avg would be 50.
	noteDelta(state, 400, 1_000);
	endParentResponse(state, { output: 100 }, 3_000);
	// Child t1 settles with its JSONL timing: 8,000 ms / 300 tokens.
	const timing: ChildTiming = { generationMs: 8_000, timedOutput: 300 };
	assert.equal(noteChild(state, childUsageEvent("t1", { input: 500, output: 300 }), 5_000, 2_000, timing), true);
	assert.equal(state.childTimingMs, 8_000);
	assert.equal(state.childTimedOutput, 300);
	// Combined: (2,000 + 8,000) ms / (100 + 300) tokens = 40 tok/s, distinct
	// from the parent-only 50 so the assertion actually proves the child folded in.
	assert.equal(rates(state, 0).average, 40);
	assert.deepEqual(totals(state), { input: 500, output: 400, cacheRead: 0, cacheWrite: 0 });
});

test("a replacement snapshot replaces the child's timing instead of stacking it", () => {
	const state = createState();
	noteChild(state, childUsageEvent("t1", { output: 150 }), 5_000, 2_000, { generationMs: 3_000, timedOutput: 150 });
	noteChild(state, childUsageEvent("t1", { output: 300 }), 9_000, 2_000, { generationMs: 6_000, timedOutput: 300 });
	assert.equal(state.childTimingMs, 6_000);
	assert.equal(state.childTimedOutput, 300);
});

test("a child without timing contributes tokens but not average time", () => {
	const state = createState();
	noteDelta(state, 400, 1_000);
	endParentResponse(state, { output: 100 }, 3_000); // 2,000 ms / 100 tokens
	// Untimed child: tokens count, timing does not.
	assert.equal(noteChild(state, childUsageEvent("t1", { output: 40 }), 5_000, 2_000), true);
	assert.equal(state.childTimingMs, 0);
	assert.equal(state.childTimedOutput, 0);
	// avg falls back to the timed subset (parent only), not to a guess.
	assert.equal(rates(state, 0).average, 50);
});

test("a degenerate timing payload clears a stored one instead of stacking zeros", () => {
	const state = createState();
	noteChild(state, childUsageEvent("t1", { output: 150 }), 5_000, 2_000, { generationMs: 3_000, timedOutput: 150 });
	// Re-delivery without timing (unreadable session, for example) drops it.
	noteChild(state, childUsageEvent("t1", { output: 150 }), 5_000, 2_000);
	assert.equal(state.childTimingMs, 0);
	assert.equal(state.childTimedOutput, 0);
});

test("dropChild removes the child's timing with its tokens and wall time", () => {
	const state = createState();
	noteChild(state, childUsageEvent("t1", { output: 150 }), 5_000, 2_000, { generationMs: 3_000, timedOutput: 150 });
	assert.equal(dropChild(state, "t1"), true);
	assert.equal(state.childTimingMs, 0);
	assert.equal(state.childTimedOutput, 0);
});

test("a persisted tombstone drops the child's timing too", () => {
	const state = createState();
	foldChildEntries(state, [childEntry("t1", { output: 150, timingMs: 3_000, timedOutput: 150 })]);
	assert.equal(state.childTimingMs, 3_000);
	assert.equal(applyChildSnapshot(state, { taskId: "t1", revoked: true }), true);
	assert.equal(state.childTimingMs, 0);
	assert.equal(state.childTimedOutput, 0);
});

// --- persistence round-trip --------------------------------------------------

test("foldChildEntries restores child timing from persisted snapshots", () => {
	const state = createState();
	foldChildEntries(state, [
		childEntry("t1", { output: 150, wallMs: 3_000, timingMs: 3_000, timedOutput: 150 }),
		childEntry("t2", { output: 40 }), // untimed child persists no timing fields
	]);
	assert.equal(state.childTimingMs, 3_000);
	assert.equal(state.childTimedOutput, 150);
	// Combined average over parent timing restored by foldTimingEntries + child timing.
	foldChildEntries(state, []);
	assert.equal(state.childTimingMs, 3_000);
});

test("malformed persisted timing values are ignored, tokens still count", () => {
	const state = createState();
	foldChildEntries(state, [childEntry("t1", { output: 150, timingMs: Number.NaN, timedOutput: -5 })]);
	assert.equal(state.childTimingMs, 0);
	assert.equal(state.childTimedOutput, 0);
	assert.deepEqual(totals(state), { input: 0, output: 150, cacheRead: 0, cacheWrite: 0 });
});

test("persisted timing replaces on re-fold instead of stacking", () => {
	const state = createState();
	const entries = [childEntry("t1", { output: 150, timingMs: 3_000, timedOutput: 150 })];
	foldChildEntries(state, entries);
	foldChildEntries(state, entries); // resume re-fold
	assert.equal(state.childTimingMs, 3_000);
	assert.equal(state.childTimedOutput, 150);
});

// --- combined average edge cases ---------------------------------------------

test("combined average stays undefined when no timed output exists", () => {
	const state = createState();
	assert.equal(rates(state, 0).average, undefined);
	noteChild(state, childUsageEvent("t1", { output: 150 }), 5_000, 2_000); // tokens, no timing
	assert.equal(rates(state, 0).average, undefined);
});

test("parent-only behavior is unchanged without child timing", () => {
	const state = createState();
	noteDelta(state, 400, 1_000);
	endParentResponse(state, { output: 100 }, 3_000);
	assert.equal(rates(state, 0).average, 50);
	noteChild(state, childUsageEvent("t1", { output: 40 }), 5_000, 2_000);
	assert.equal(rates(state, 0).average, 50); // still parent-only
	assert.equal(rates(state, 0).subagent, 40 / 3); // task throughput untouched
});

// --- disk join: task record -> child session JSONL ---------------------------

test("resolveAgentHome follows the gentle-pi resolution chain", () => {
	const original = { a: process.env.GENTLE_PI_AGENT_HOME, b: process.env.PI_CODING_AGENT_DIR };
	try {
		process.env.GENTLE_PI_AGENT_HOME = "/tmp/override-a";
		process.env.PI_CODING_AGENT_DIR = "/tmp/override-b";
		assert.equal(resolveAgentHome(), "/tmp/override-a");
		delete process.env.GENTLE_PI_AGENT_HOME;
		assert.equal(resolveAgentHome(), "/tmp/override-b");
		delete process.env.PI_CODING_AGENT_DIR;
		assert.notEqual(resolveAgentHome(), ""); // falls back to ~/.pi/agent
	} finally {
		if (original.a === undefined) delete process.env.GENTLE_PI_AGENT_HOME; else process.env.GENTLE_PI_AGENT_HOME = original.a;
		if (original.b === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = original.b;
	}
});

test("readChildTiming joins the task record's sessionPath and parses its JSONL", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-meter-test-"));
	try {
		const agentHome = join(dir, "agent");
		const sessions = join(agentHome, "gentle-agents", "sessions");
		mkdirSync(sessions, { recursive: true });
		const sessionFile = join(sessions, "child.jsonl");
		writeFileSync(sessionFile, [assistantLine(100, 2_000), assistantLine(50, 1_000)].join("\n"));
		const tasks = join(agentHome, "gentle-agents", "tasks");
		mkdirSync(tasks, { recursive: true });
		writeFileSync(join(tasks, "task-1.json"), JSON.stringify({ task: { id: "task-1", sessionPath: sessionFile } }));
		assert.deepEqual(await readChildTiming(agentHome, "task-1"), { generationMs: 3_000, timedOutput: 150 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readChildTiming degrades honestly on missing record, session, or unsafe id", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-meter-test-"));
	try {
		const agentHome = join(dir, "agent");
		mkdirSync(join(agentHome, "gentle-agents", "tasks"), { recursive: true });
		assert.equal(await readChildTiming(agentHome, "missing-task"), undefined); // no task record
		writeFileSync(join(agentHome, "gentle-agents", "tasks", "task-2.json"), JSON.stringify({ task: { id: "task-2", sessionPath: join(dir, "gone.jsonl") } }));
		assert.equal(await readChildTiming(agentHome, "task-2"), undefined); // session file gone
		writeFileSync(join(agentHome, "gentle-agents", "tasks", "task-3.json"), JSON.stringify({ task: { id: "task-3" } }));
		assert.equal(await readChildTiming(agentHome, "task-3"), undefined); // no sessionPath
		assert.equal(await readChildTiming(agentHome, "../escape"), undefined); // unsafe id never touches disk
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
