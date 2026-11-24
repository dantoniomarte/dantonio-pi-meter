/**
 * Live decode rate for running children — tailing, not guessing.
 *
 * The child metrics bus event fires only at settle, so a live child rate must
 * come from the child's session JSONL, the same file Pi writes while the child
 * generates. Each tracked child is read incrementally (byte offset + held
 * partial line); new timed assistant messages enter a last-five rolling
 * window, and the aggregate rate is total windowed output over total windowed
 * duration across running children — sum over sum, never a mean of rates.
 *
 * All reads are best-effort: a missing file or an unreadable line degrades to
 * "no rate", never to an invented number.
 */

import { open } from "node:fs/promises";

export interface TimedMessage {
	output: number;
	durationMs: number;
}

/** One timed assistant JSONL line; anything else is not a data point. */
export function parseTimedLine(line: string): TimedMessage | undefined {
	if (!line.trim()) return undefined;
	let entry: unknown;
	try {
		entry = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!entry || typeof entry !== "object") return undefined;
	const message = (entry as { message?: unknown }).message;
	if (!message || typeof message !== "object") return undefined;
	const candidate = message as { role?: unknown; usage?: { output?: unknown }; durationMs?: unknown };
	if (candidate.role !== "assistant") return undefined;
	const duration = candidate.durationMs;
	if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) return undefined;
	const output = candidate.usage?.output;
	if (typeof output !== "number" || !Number.isFinite(output) || output <= 0) return undefined;
	return { output, durationMs: duration };
}

/** Rolling window size per child: fresh enough, stable enough. */
const WINDOW = 5;
/** A single JSONL line can be large; beyond this it is skipped, not parsed. */
const MAX_REMAINDER = 1_048_576;
/** Path-resolution attempts before a child degrades to "no live rate". */
const MAX_PATH_ATTEMPTS = 40;
/** Per-tick read cap so one pathological file cannot stall the line. */
const MAX_READ_BYTES = 8 * 1_048_576;

interface TailState {
	path?: string;
	pathAttempts: number;
	offset: number;
	remainder: string;
	window: TimedMessage[];
	/** Last seen mtime, to detect truncate-and-rewrite at the same size. */
	mtimeMs?: number;
	resolvePath: PathResolver;
}

type PathResolver = () => Promise<string | null | undefined>;

/**
 * Incremental JSONL tails for running children. The meter drives `tick()` on
 * its render cadence (only while children are tracked — never on an idle
 * clock) and reads `rate()` when painting the line.
 */
export class LiveChildTails {
	private tails = new Map<string, TailState>();

	/** Start tailing one running child. Returns false if already tracked. */
	track(taskId: string, resolvePath: PathResolver): boolean {
		if (this.tails.has(taskId)) return false;
		this.tails.set(taskId, { pathAttempts: 0, offset: 0, remainder: "", window: [], resolvePath });
		return true;
	}

	/** Stop tailing one child. Returns true when it was tracked. */
	untrack(taskId: string): boolean {
		return this.tails.delete(taskId);
	}

	clear(): void {
		this.tails.clear();
	}

	get size(): number {
		return this.tails.size;
	}

	/** Aggregate windowed rate across tracked children: sum over sum. */
	rate(): number | undefined {
		let output = 0;
		let durationMs = 0;
		for (const tail of this.tails.values()) {
			for (const message of tail.window) {
				output += message.output;
				durationMs += message.durationMs;
			}
		}
		return durationMs > 0 && output > 0 ? output / (durationMs / 1000) : undefined;
	}

	/**
	 * Read every tracked child's new lines once. Returns true when any timed
	 * message was counted (so the caller repaints), false otherwise.
	 */
	async tick(): Promise<boolean> {
		let changed = false;
		for (const [taskId, tail] of [...this.tails]) {
			try {
				changed = (await this.tickOne(taskId, tail)) || changed;
			} catch {
				// A vanished or unreadable file resets the child's window; its
				// rate simply stops contributing until new lines arrive.
				tail.offset = 0;
				tail.remainder = "";
				tail.window = [];
			}
		}
		return changed;
	}

	private async tickOne(taskId: string, tail: TailState): Promise<boolean> {
		if (tail.path === undefined) {
			tail.pathAttempts += 1;
			const path = await tail.resolvePath();
			if (typeof path !== "string" || path.length === 0) {
				// Bounded retries: the launch record should gain its sessionPath
				// within moments; a child that never resolves degrades off.
				if (tail.pathAttempts >= MAX_PATH_ATTEMPTS) this.untrack(taskId);
				return false;
			}
			tail.path = path;
			tail.offset = 0;
			tail.remainder = "";
			tail.window = [];
		}
		const handle = await open(tail.path, "r");
		try {
			const stat = await handle.stat();
			const size = stat.size;
			if (size < tail.offset || (size <= tail.offset && tail.mtimeMs !== undefined && stat.mtimeMs !== tail.mtimeMs)) {
				// Truncated, or truncated and rewritten at the same size: start
				// over instead of reading garbage or missing the rewrite.
				tail.offset = 0;
				tail.remainder = "";
				tail.window = [];
			}
			tail.mtimeMs = stat.mtimeMs;
			const length = Math.min(size - tail.offset, MAX_READ_BYTES);
			if (length <= 0) return false;
			const buffer = Buffer.allocUnsafe(length);
			await handle.read(buffer, 0, length, tail.offset);
			tail.offset += buffer.byteLength;
			let changed = false;
			const data = tail.remainder + buffer.toString("utf8");
			const lines = data.split("\n");
			// A chunk not ending in a newline holds its last piece until complete.
			tail.remainder = data.endsWith("\n") ? "" : lines.pop() ?? "";
			if (tail.remainder.length > MAX_REMAINDER) tail.remainder = "";
			for (const line of lines) {
				const message = parseTimedLine(line);
				if (!message) continue;
				tail.window.push(message);
				if (tail.window.length > WINDOW) tail.window.shift();
				changed = true;
			}
			return changed;
		} finally {
			await handle.close();
		}
	}
}
