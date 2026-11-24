/**
 * Child session timing: the decode time pi-meter cannot get from the bus.
 *
 * gentle-pi's child metrics event (`gentle:runtime-metrics:child/v1`) fires
 * once at settle and carries no per-response timing, so the combined session
 * average joins two files Pi itself writes — no host changes:
 *
 * 1. Task record: `<agentHome>/gentle-agents/tasks/<taskId>.json`, whose
 *    `task.sessionPath` points at the child's session JSONL.
 * 2. Child session JSONL: assistant entries carry `message.usage.output` and
 *    `message.durationMs` (monotonic generation duration, absent for legacy
 *    messages). Entries with `stopReason: "error"` report `output: 0`, so the
 *    `output > 0` rule already excludes them — no special-casing.
 *
 * All reads are best-effort: any missing or malformed input degrades to "no
 * timing" and the child still counts its relay-reported tokens.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChildTiming } from "./state.ts";

export type { ChildTiming };

/** Same task-id safety rule gentle-pi's own history uses. */
const SAFE_ID = /^[a-z0-9-]+$/i;

/** Sum `durationMs`/`output` over timed assistant entries; ignore the rest. */
export function parseTimedMessages(text: string): ChildTiming {
	let generationMs = 0;
	let timedOutput = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (!entry || typeof entry !== "object") continue;
		const message = (entry as { message?: unknown }).message;
		if (!message || typeof message !== "object") continue;
		const candidate = message as { role?: unknown; usage?: { output?: unknown }; durationMs?: unknown };
		if (candidate.role !== "assistant") continue;
		const duration = candidate.durationMs;
		if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) continue;
		const output = candidate.usage?.output;
		if (typeof output !== "number" || !Number.isFinite(output) || output <= 0) continue;
		generationMs += duration;
		timedOutput += output;
	}
	return { generationMs, timedOutput };
}

/**
 * Mirror gentle-pi's agent-home resolution so both packages read the same
 * directory: `GENTLE_PI_AGENT_HOME`, then `PI_CODING_AGENT_DIR`, then the
 * default `~/.pi/agent`.
 */
export function resolveAgentHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.GENTLE_PI_AGENT_HOME || env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/**
 * Read one settled child's generation timing by joining its task record with
 * its session JSONL. Returns undefined when the record, the session file, or
 * the timing itself is missing — an untimed child, never a guess. Unsafe task
 * ids never touch the filesystem.
 */
export async function readChildTiming(agentHome: string, taskId: string): Promise<ChildTiming | undefined> {
	if (!SAFE_ID.test(taskId)) return undefined;
	let sessionPath: unknown;
	try {
		const record = JSON.parse(await readFile(join(agentHome, "gentle-agents", "tasks", `${taskId}.json`), "utf8")) as {
			task?: { sessionPath?: unknown };
		};
		sessionPath = record?.task?.sessionPath;
	} catch {
		return undefined;
	}
	if (typeof sessionPath !== "string" || sessionPath.length === 0) return undefined;
	let text: string;
	try {
		text = await readFile(sessionPath, "utf8");
	} catch {
		return undefined;
	}
	const timing = parseTimedMessages(text);
	return timing.generationMs > 0 && timing.timedOutput > 0 ? timing : undefined;
}

/** Bounded settle-race retry: the host writes the task record right after the metrics event. */
const TIMING_READ_ATTEMPTS = 10;
const TIMING_RETRY_MS = 150;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `readChildTiming` with a bounded retry: at settle time the task record (and
 * its `sessionPath`) may land on disk a beat after the metrics event, so a
 * single read would spuriously drop timing for fast children. Missing timing
 * after all attempts degrades to an untimed child — never a guess.
 */
export async function readChildTimingRetried(agentHome: string, taskId: string): Promise<ChildTiming | undefined> {
	for (let attempt = 0; attempt < TIMING_READ_ATTEMPTS; attempt += 1) {
		const timing = await readChildTiming(agentHome, taskId);
		if (timing) return timing;
		if (attempt + 1 < TIMING_READ_ATTEMPTS) await sleep(TIMING_RETRY_MS);
	}
	return undefined;
}

/**
 * Resolve one child's session path from its task record. The launch record is
 * written to disk immediately at launch (#1741), but `sessionPath` may only
 * be resolved on a later write, so callers retry while the child runs.
 * Returns undefined on a missing/unreadable record, null when the record
 * exists but names no session yet, and the path otherwise.
 */
export async function readChildSessionPath(agentHome: string, taskId: string): Promise<string | null | undefined> {
	if (!SAFE_ID.test(taskId)) return undefined;
	try {
		const record = JSON.parse(await readFile(join(agentHome, "gentle-agents", "tasks", `${taskId}.json`), "utf8")) as {
			task?: { sessionPath?: unknown };
		};
		const path = record?.task?.sessionPath;
		return typeof path === "string" && path.length > 0 ? path : null;
	} catch {
		return undefined;
	}
}
