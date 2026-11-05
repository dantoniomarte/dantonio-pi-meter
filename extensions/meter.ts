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
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { addUsage, renderLine } from "./format.ts";
import { registerUsageSources } from "./usage-registry.ts";
import { customUsageProviders, registerCustomUsageSources } from "./usage-custom.ts";
import {
	createState,
	dropChild,
	endParentResponse,
	foldEntries,
	noteChild,
	noteDelta,
	rates,
	totals,
	type MeterState,
} from "./state.ts";

const WIDGET_KEY = "dantonio-pi-meter";
const TICK_MS = 250;

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

export default function meterExtension(pi: ExtensionAPI): void {
	const state = createState();
	let ctx: ExtensionContext | undefined;
	let cached = "";
	let timer: ReturnType<typeof setInterval> | undefined;

	function paint(force = false): void {
		if (!ctx?.hasUI) return;
		const now = Date.now();
		const speed = rates(state, now);
		const line = renderLine({ totals: totals(state), subagents: state.subagents, live: speed.live, average: speed.average });
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
		timer = setInterval(() => {
			if (state.liveStartedAt === undefined) {
				clearInterval(timer);
				timer = undefined;
				return;
			}
			paint();
		}, TICK_MS);
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
			foldEntries(state, ctx.sessionManager.getEntries());
		} catch {
			// Bootstrap is best-effort; live events still accrue.
		}
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

	pi.events?.on?.(CHILD_METRICS_EVENT, (value: unknown) => {
		const event = value as ChildMetricsEvent | null;
		// Task throughput uses the settle moment as the right edge of the
		// launch->settle wall-time window.
		if (noteChild(state, value, Date.now(), event?.launchedAt)) paint(true);
	});

	pi.events?.on?.(CHILD_METRICS_REVOKED, (taskId: unknown) => {
		if (typeof taskId === "string" && dropChild(state, taskId)) paint(true);
	});

	pi.on("session_shutdown", async () => {
		stopTick();
		ctx = undefined;
	});
}
