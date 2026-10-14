/**
 * Paket D (J13, Review 24.09.): one small async-lifecycle adapter for all hooks.
 *
 * - bounded concurrency (default 1) — jobs never run in parallel;
 * - `guard()` is checked at enqueue AND before send (mode/G1 re-check at send time);
 * - no visible apply happens without a fresh guard check inside the job body.
 *
 * D14 (Audit 26.09.): the concurrency cap never bounded the queue itself — 120 jobs were
 * admitted and their closures retained the full payloads. The runner now carries a load
 * contract: `maxPending`, `maxRetainedBytes`, `maxQueueWaitMs` and per-key coalescing.
 * Every refused job is counted (`dropped`/`coalesced`/`expired`/`gated`) and measurable via
 * `stats()` — no silent cost. A job that exceeds `maxRetainedBytes` is only refused while it
 * would actually wait (an idle runner starts it immediately); the cap bounds accumulation,
 * not a single in-flight result.
 */
export interface AsyncJob {
	run: () => Promise<void>;
	guard: () => boolean;
	/** Retained payload estimate; the runner sums queued bytes against `maxRetainedBytes`. */
	bytes?: number;
	/** Absolute epoch ms; a job not started by then is expired at the pump. */
	deadline?: number;
	/** At most one queued job per key — the newest enqueue replaces the older payload. */
	coalesceKey?: string;
}

export type EnqueueOutcome = "queued" | "replaced" | "dropped" | "expired" | "gated";

export interface AsyncQueueStats {
	active: number;
	pending: number;
	retainedBytes: number;
	/** Jobs that left the queue and started running. */
	admitted: number;
	dropped: number;
	coalesced: number;
	expired: number;
	/** Refused because the guard was false at enqueue or at send. */
	gated: number;
}

export interface AsyncJobRunner {
	enqueue(job: AsyncJob): EnqueueOutcome;
	pending(): Promise<void>;
	activeCount(): number;
	stats(): AsyncQueueStats;
}

export interface AsyncJobRunnerOptions {
	/** Queue length cap. */
	maxPending?: number;
	/** Sum of `bytes` retained by queued jobs. */
	maxRetainedBytes?: number;
	/** Default queue-wait deadline; 0 disables the runner-imposed deadline. */
	maxQueueWaitMs?: number;
}

const DEFAULT_MAX_PENDING = 32;
const DEFAULT_MAX_RETAINED_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_QUEUE_WAIT_MS = 60_000;

export function createAsyncJobRunner(concurrency = 1, options: AsyncJobRunnerOptions = {}): AsyncJobRunner {
	const maxPending = Math.max(0, options.maxPending ?? DEFAULT_MAX_PENDING);
	const maxRetainedBytes = Math.max(0, options.maxRetainedBytes ?? DEFAULT_MAX_RETAINED_BYTES);
	const maxQueueWaitMs = Math.max(0, options.maxQueueWaitMs ?? DEFAULT_MAX_QUEUE_WAIT_MS);
	const queue: AsyncJob[] = [];
	const idle: Array<() => void> = [];
	let active = 0;
	let retainedBytes = 0;
	const counters = { admitted: 0, dropped: 0, coalesced: 0, expired: 0, gated: 0 };

	const settleIdle = () => {
		if (active === 0 && queue.length === 0) {
			for (const resolve of idle.splice(0)) resolve();
		}
	};

	const pump = () => {
		while (active < concurrency && queue.length) {
			const job = queue.shift() as AsyncJob;
			retainedBytes -= job.bytes ?? 0;
			if (job.deadline !== undefined && Date.now() > job.deadline) {
				counters.expired += 1;
				continue;
			}
			if (!job.guard()) {
				counters.gated += 1;
				continue;
			}
			counters.admitted += 1;
			active += 1;
			void (async () => {
				try {
					await job.run();
				} catch {
					/* advisory only — a hook failure must never disturb the agent */
				} finally {
					active -= 1;
					pump();
					settleIdle();
				}
			})();
		}
		settleIdle();
	};

	return {
		enqueue(job) {
			const bytes = Number.isFinite(job.bytes) ? Math.max(0, Math.round(job.bytes as number)) : 0;
			if (bytes > 0) job = { ...job, bytes };
			const deadline = job.deadline ?? (maxQueueWaitMs > 0 ? Date.now() + maxQueueWaitMs : undefined);
			if (deadline !== undefined) job = { ...job, deadline };
			if (deadline !== undefined && Date.now() > deadline) {
				counters.expired += 1;
				return "expired";
			}
			if (!job.guard()) {
				counters.gated += 1;
				return "gated";
			}
			if (job.coalesceKey !== undefined) {
				const index = queue.findIndex((queued) => queued.coalesceKey === job.coalesceKey);
				if (index >= 0) {
					const nextBytes = retainedBytes - (queue[index].bytes ?? 0) + (job.bytes ?? 0);
					if (bytes > 0 && nextBytes > maxRetainedBytes) {
						// The replacement itself would overrun the cap: keep the queued payload, count the refusal.
						counters.dropped += 1;
						return "dropped";
					}
					retainedBytes = nextBytes;
					queue[index] = job;
					counters.coalesced += 1;
					return "replaced";
				}
			}
			// A free runner starts the job without it ever waiting; the caps bound accumulation.
			const startsNow = active < concurrency && queue.length === 0;
			if (!startsNow) {
				if (queue.length >= maxPending) {
					counters.dropped += 1;
					return "dropped";
				}
				if (bytes > 0 && retainedBytes + bytes > maxRetainedBytes) {
					counters.dropped += 1;
					return "dropped";
				}
			}
			retainedBytes += bytes;
			queue.push(job);
			pump();
			return "queued";
		},
		pending() {
			if (active === 0 && queue.length === 0) return Promise.resolve();
			return new Promise((resolve) => {
				idle.push(resolve);
			});
		},
		activeCount() {
			return active;
		},
		stats() {
			return { active, pending: queue.length, retainedBytes, ...counters };
		},
	};
}
