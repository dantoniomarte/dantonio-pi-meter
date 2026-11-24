import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LiveChildTails, parseTimedLine } from "../extensions/child-live.ts";
import { renderLine } from "../extensions/format.ts";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function assistantLine(output: number, durationMs: number): string {
	return JSON.stringify({
		type: "message",
		message: { role: "assistant", content: [], usage: { output }, durationMs, stopReason: "stop" },
	});
}

// --- per-line extraction -----------------------------------------------------

test("parseTimedLine extracts timed assistant entries only", () => {
	assert.deepEqual(parseTimedLine(assistantLine(100, 2_000)), { output: 100, durationMs: 2_000 });
	assert.equal(parseTimedLine(JSON.stringify({ type: "message", message: { role: "user", content: "hi" } })), undefined);
	assert.equal(parseTimedLine(JSON.stringify({ type: "message", message: { role: "assistant", usage: { output: 80 } } })), undefined); // legacy
	assert.equal(parseTimedLine("not json"), undefined);
	assert.equal(parseTimedLine(""), undefined);
});

// --- incremental tail ----------------------------------------------------------

function tempSession(): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-meter-tail-"));
	const path = join(dir, "child.jsonl");
	writeFileSync(path, "", "utf8");
	return { dir, path };
}

test("the tail counts only lines appended since the last tick", async () => {
	const { dir, path } = tempSession();
	try {
		const tails = new LiveChildTails();
		let resolved = 0;
		tails.track("t1", async () => {
			resolved += 1;
			return path;
		});
		appendFileSync(path, assistantLine(100, 2_000) + "\n", "utf8");
		assert.equal(await tails.tick(), true); // first message seen
		assert.equal(tails.rate(), 50); // 100 tokens / 2 s
		appendFileSync(path, assistantLine(50, 1_000) + "\n", "utf8");
		assert.equal(await tails.tick(), true);
		// Rolling window covers both messages: 150 / 3 s.
		assert.equal(tails.rate(), 50);
		assert.ok(resolved >= 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a tick without new lines reports no change and keeps the rate", async () => {
	const { dir, path } = tempSession();
	try {
		const tails = new LiveChildTails();
		tails.track("t1", async () => path);
		appendFileSync(path, assistantLine(100, 2_000) + "\n", "utf8");
		await tails.tick();
		const rate = tails.rate();
		assert.equal(await tails.tick(), false); // nothing new
		assert.equal(tails.rate(), rate);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a partial line is held until its newline arrives", async () => {
	const { dir, path } = tempSession();
	try {
		const tails = new LiveChildTails();
		tails.track("t1", async () => path);
		const full = assistantLine(100, 2_000) + "\n";
		appendFileSync(path, full.slice(0, 20), "utf8");
		assert.equal(await tails.tick(), false); // incomplete JSON line: held
		assert.equal(tails.rate(), undefined);
		appendFileSync(path, full.slice(20), "utf8");
		assert.equal(await tails.tick(), true); // now complete
		assert.equal(tails.rate(), 50);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a truncated file resets the tail instead of reading garbage", async () => {
	const { dir, path } = tempSession();
	try {
		const tails = new LiveChildTails();
		tails.track("t1", async () => path);
		appendFileSync(path, assistantLine(100, 2_000) + "\n", "utf8");
		await tails.tick();
		truncateSync(path, 0);
		appendFileSync(path, assistantLine(60, 3_000) + "\n", "utf8");
		assert.equal(await tails.tick(), true);
		assert.equal(tails.rate(), 20); // recounted from the reset file only
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- window, aggregation, lifecycle -------------------------------------------

test("the rate window keeps only the last five timed messages", async () => {
	const { dir, path } = tempSession();
	try {
		const tails = new LiveChildTails();
		tails.track("t1", async () => path);
		const lines = [
			assistantLine(10_000, 1_000), // old, heavy, slow: must fall off
			assistantLine(100, 1_000),
			assistantLine(100, 1_000),
			assistantLine(100, 1_000),
			assistantLine(100, 1_000),
			assistantLine(100, 1_000),
		];
		for (const line of lines) {
			appendFileSync(path, line + "\n", "utf8");
			await tails.tick();
		}
		// Window = last five uniform messages: 500 tokens / 5 s.
		assert.equal(tails.rate(), 100);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("rates from several running children aggregate over summed units", async () => {
	const { dir: d1, path: p1 } = tempSession();
	const { dir: d2, path: p2 } = tempSession();
	try {
		const tails = new LiveChildTails();
		tails.track("t1", async () => p1);
		tails.track("t2", async () => p2);
		appendFileSync(p1, assistantLine(100, 2_000) + "\n", "utf8"); // 50 tok/s
		appendFileSync(p2, assistantLine(300, 1_000) + "\n", "utf8"); // 300 tok/s
		await tails.tick();
		// 400 tokens / 3 s — never the mean of the rates.
		assert.equal(Math.round(tails.rate()!), 133);
	} finally {
		rmSync(d1, { recursive: true, force: true });
		rmSync(d2, { recursive: true, force: true });
	}
});

test("an unresolved session path retries bounded, then degrades off", async () => {
	const { dir, path } = tempSession();
	try {
		const tails = new LiveChildTails();
		let attempts = 0;
		tails.track("t1", async () => {
			attempts += 1;
			return attempts >= 3 ? path : null; // record not ready at first
		});
		appendFileSync(path, assistantLine(100, 2_000) + "\n", "utf8");
		await tails.tick(); // attempt 1: null
		await tails.tick(); // attempt 2: null
		assert.equal(tails.rate(), undefined);
		await tails.tick(); // attempt 3: resolved, message counted
		assert.equal(tails.rate(), 50);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("untrack drops a child's rate; idle tails report nothing", async () => {
	const { dir, path } = tempSession();
	try {
		const tails = new LiveChildTails();
		tails.track("t1", async () => path);
		appendFileSync(path, assistantLine(100, 2_000) + "\n", "utf8");
		await tails.tick();
		assert.ok(tails.rate() !== undefined);
		tails.untrack("t1");
		assert.equal(tails.rate(), undefined);
		assert.equal(await tails.tick(), false); // nothing tracked: no-op
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a child whose file vanishes stops contributing without crashing", async () => {
	const { dir, path } = tempSession();
	try {
		const tails = new LiveChildTails();
		tails.track("t1", async () => path);
		appendFileSync(path, assistantLine(100, 2_000) + "\n", "utf8");
		await tails.tick();
		rmSync(path, { force: true });
		await Promise.resolve();
		assert.equal(await tails.tick(), false); // read error swallowed
		assert.equal(tails.rate(), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- rendering ---------------------------------------------------------------

test("renderLine shows the live child rate as its own segment", () => {
	const line = renderLine({ totals: zero, subagents: 1, childLive: 55.4 });
	assert.match(line, /sa 55\.4 tok\/s/);
	// Absent when no child is streaming: never a fake rate.
	const idle = renderLine({ totals: zero, subagents: 1 });
	assert.equal(idle.includes("sa "), false);
});
