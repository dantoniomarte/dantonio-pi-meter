/**
 * dantonio-pi-meter — one subtle line above the editor.
 *
 * Shows session totals (orchestrator + settled subagents) for input, output,
 * cache read and cache write, plus a live tokens/second, a session average,
 * and the settled-subagent task throughput beside the count marker.
 *
 * Render cost: the line is a cached string. It is rebuilt at most 4 times per
 * second while the parent streams, once when a response or subagent settles,
 * and never on a clock. The TUI diffs by line, so an unchanged string writes
 * nothing to the terminal.
 *
 * Subagent tokens are persisted as custom session entries at settle time and
 * restored on session start, so resume and reload keep the child totals.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { addUsage, renderLine } from "./format.ts";
import { readChildSessionPath, readChildTimingRetried, resolveAgentHome } from "./child-sessions.ts";
import { LiveChildTails } from "./child-live.ts";
import { registerUsageSources } from "./usage-registry.ts";
import { customUsageProviders, registerCustomUsageSources } from "./usage-custom.ts";
import {
	CHILD_SNAPSHOT_TYPE,
	createState,
	dropChild,
	endParentResponse,
	foldChildEntries,
	foldEntries,
	foldTimingEntries,
	noteChild,
	noteDelta,
	persistTiming,
	rates,
	totals,
	type ChildSnapshotData,
	type GenerationTiming,
	type MeterState,
	setChildTiming,
} from "./state.ts";

const WIDGET_KEY = "dantonio-pi-meter";
const TICK_MS = 250;

/**
 * Children restored from older snapshots may carry no decode timing; read it
 * from their session JSONL once at session start, never blocking the line.
 */
async function backfillChildTiming(state: MeterState, agentHome: string): Promise<boolean> {
	let changed = false;
	for (const taskId of [...state.children.keys()]) {
		if (state.childrenTiming.has(taskId)) continue;
		const timing = await readChildTimingRetried(agentHome, taskId);
		// The task can be revoked while we read; re-check before folding.
		if (timing && setChildTiming(state, taskId, timing)) changed = true;
	}
	return changed;
}

interface AssistantEvent {
	message: { role?: string; usage?: Partial<MeterState["parent"]> };
	assistantMessageEvent?: { type?: string; delta?: string };
}

interface CompactEvent {
	compactionEntry?: { usage?: Partial<MeterState["parent"]> };
}

interface ChildMetricsEvent {
	taskId: string;
	launchedAt?: number;
	responses: unknown[];
}

const CHILD_METRICS_EVENT = "gentle:runtime-metrics:child/v1";
const CHILD_METRICS_REVOKED = "gentle:runtime-metrics:revoked/v1";

/** gentle-pi's task-status notification: the only launch/run signal on the bus. */
interface ChildStatusEvent {
	taskId?: string;
	status?: string;
	event?: string;
}
const CHILD_STATUS_EVENT = "gentle-pi:notification:source";
const CHILD_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out"]);

function persistChild(state: MeterState, taskId: string, appendEntry: (customType: string, data?: unknown) => void): void {
	const snapshot = state.children.get(taskId);
	if (!snapshot) return;
	const data: ChildSnapshotData = {
		taskId,
		input: snapshot.input,
		output: snapshot.output,
		cacheRead: snapshot.cacheRead,
		cacheWrite: snapshot.cacheWrite,
	};
	const wallMs = state.childrenMs.get(taskId);
	if (wallMs !== undefined) data.wallMs = wallMs;
	const timing = state.childrenTiming.get(taskId);
	if (timing) {
		data.timingMs = timing.generationMs;
		data.timedOutput = timing.timedOutput;
	}
	try {
		appendEntry(CHILD_SNAPSHOT_TYPE, data);
	} catch {
		// Persistence is best-effort; the live line stays correct.
	}
}

export default function meterExtension(pi: ExtensionAPI): void {
	const state = createState();
	let ctx: ExtensionContext | undefined;
	let cached = "";
	let timer: ReturnType<typeof setInterval> | undefined;
	/** Last cumulative timing appended to the session, to skip no-op entries. */
	let persistedTiming: GenerationTiming = { generationMs: 0, timedOutput: 0 };
	/** Child session home, resolved once per session (mirrors gentle-pi). */
	let agentHome: string | undefined;
	/** Live decode tails for running children; driven by the render cadence. */
	const tails = new LiveChildTails();

	const appendEntry = typeof pi.appendEntry === "function" ? pi.appendEntry.bind(pi) : undefined;

	function paint(force = false): void {
		if (!ctx?.hasUI) return;
		const now = Date.now();
		const speed = rates(state, now);
		const line = renderLine({ totals: totals(state), subagents: state.subagents, live: speed.live, average: speed.average, subagentRate: speed.subagent, childLive: tails.rate() });
		if (!force && line === cached) return;
		cached = line;
		try {
			ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
				render(width: number): string[] {
					return [truncateToWidth(theme.fg("muted", line), width)];
				},
				invalidate(): void {},
			}), { placement: "aboveEditor" });
		} catch {
			// A meter must never take the session down.
		}
	}

	function ensureTick(): void {
		if (timer || !ctx?.hasUI) return;
		if (state.liveStartedAt === undefined && tails.size === 0) return;
		timer = setInterval(() => {
			const parentStreaming = state.liveStartedAt !== undefined;
			const childStreaming = tails.size > 0;
			if (!parentStreaming && !childStreaming) {
				clearInterval(timer);
				timer = undefined;
				return;
			}
			// Child tails read at render cadence: new timed messages repaint the
			// line once, never per character.
			if (childStreaming) {
				void tails.tick().then((changed) => {
					if (changed) paint();
				}).catch(() => {
					// A failed read leaves the previous rate in place.
				});
			}
			if (parentStreaming) paint();
		}, TICK_MS);
	}
	}

	function stopTick(): void {
		if (!timer) return;
		clearInterval(timer);
		timer = undefined;
	}

	pi.on("session_start", async (_event, next) => {
		ctx = next;
		// A resumed or reloaded session must start from its full history, not
		// from the moment this process came up.
		try {
			const entries = ctx.sessionManager.getEntries();
			foldEntries(state, entries);
			// Restores the child snapshots persisted at settle time, so the
			// subagent totals survive resume and reload, plus the cumulative
			// avg timing so the session average also survives.
			foldChildEntries(state, entries);
			foldTimingEntries(state, entries);
		} catch {
			// Bootstrap is best-effort; live events still accrue.
		}
		persistedTiming = { generationMs: state.generationMs, timedOutput: state.timedOutput };
		agentHome = resolveAgentHome();
		// Snapshots restored from older sessions (or persisted untimed) get their
		// decode timing from disk, fire-and-forget: the line paints when it lands.
		void backfillChildTiming(state, agentHome)
			.then((changed) => {
				if (changed) paint(true);
			})
			.catch(() => {
				// A failed read leaves the child untimed; nothing to report.
			});
		// Usage sources re-register per session (the shell's no-op-replace
		// pattern) and stay inert unless the session targets their provider.
		// Settings under the dantonio-pi-meter key add custom bearer sources
		// on top of the built-in registry.
		try {
			registerUsageSources(pi.events);
			const settings = typeof pi.getSettings === "function" ? pi.getSettings() : undefined;
			const custom = customUsageProviders(
				settings ? (settings as Record<string, unknown>)[WIDGET_KEY] : undefined,
			);
			registerCustomUsageSources(pi.events, custom);
		} catch {
			// A usage source must never take the session down.
		}
		paint(true);
	});

	pi.on("message_update", async (event) => {
		const update = event as AssistantEvent;
		if (update.message?.role !== "assistant") return;
		const payload = update.assistantMessageEvent;
		if (payload?.type !== "text_delta" && payload?.type !== "thinking_delta" && payload?.type !== "toolcall_delta") return;
		noteDelta(state, payload.delta?.length ?? 0, Date.now());
		ensureTick();
	});

	pi.on("message_end", async (event) => {
		const update = event as AssistantEvent;
		if (update.message?.role === "assistant") {
			stopTick();
			endParentResponse(state, update.message.usage, Date.now());
			// Cumulative snapshot per timed response: the last entry wins on fold.
			if (appendEntry && persistTiming(state, appendEntry)) {
				persistedTiming = { generationMs: state.generationMs, timedOutput: state.timedOutput };
			}
			paint(true);
			return;
		}
		// Summary tool results carry their own usage in canonical totals.
		if (update.message?.role === "toolResult" && update.message.usage) {
			addUsage(state.parent, update.message.usage);
			paint(true);
		}
	});

	// A fresh compaction's summary tokens land as a compaction entry in the
	// session file; fold them as they happen so the line stays reconciled.
	pi.on("session_compact", async (event) => {
		const entry = (event as CompactEvent).compactionEntry;
		if (entry?.usage) {
			addUsage(state.parent, entry.usage);
			paint(true);
		}
	});

	pi.events?.on?.(CHILD_STATUS_EVENT, (value: unknown) => {
		const event = value as ChildStatusEvent | null;
		if (!event || typeof event.taskId !== "string" || event.taskId.length === 0) return;
		if (agentHome === undefined) return;
		if (typeof event.status === "string" && CHILD_TERMINAL_STATUSES.has(event.status)) {
			// Settled children stop contributing a live rate; their decode timing
			// folds into avg through the metrics path below.
			if (tails.untrack(event.taskId)) paint(true);
			return;
		}
		if (tails.track(event.taskId, () => readChildSessionPath(agentHome!, event.taskId!))) {
			paint(true);
			ensureTick();
		}
	});

	pi.events?.on?.(CHILD_METRICS_EVENT, async (value: unknown) => {
		const event = value as ChildMetricsEvent | null;
		// gentle-pi emits launchedAt on its performance.now() monotonic clock
		// (uptime ms, not epoch), so the settle edge must use the same clock;
		// mixing in Date.now() once produced ~1.795e12 ms wall windows.
		const settleAt = performance.now();
		// Decode timing comes from the child's session JSONL on disk; the host
		// writes the task record right after this event, so the join retries a
		// bounded number of times before degrading to an untimed child.
		const timing = event && agentHome !== undefined ? await readChildTimingRetried(agentHome, event.taskId) : undefined;
		// The task settled: its live tail ends here even if the status
		// notification raced ahead of or behind this event.
		const wasLive = tails.untrack(event?.taskId ?? "");
		if (!noteChild(state, value, settleAt, event?.launchedAt, timing)) {
			if (wasLive) paint(true);
			return;
		}
		if (appendEntry && event) persistChild(state, event.taskId, appendEntry);
		paint(true);
	});

	pi.events?.on?.(CHILD_METRICS_REVOKED, (taskId: unknown) => {
		tails.untrack(typeof taskId === "string" ? taskId : "");
		if (typeof taskId !== "string" || !dropChild(state, taskId)) return;
		try {
			appendEntry?.(CHILD_SNAPSHOT_TYPE, { taskId, revoked: true });
		} catch {
			// Persistence is best-effort; the live line stays correct.
		}
		paint(true);
	});

	pi.on("session_shutdown", async () => {
		stopTick();
		tails.clear();
		ctx = undefined;
	});
}
