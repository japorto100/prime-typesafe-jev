/**
 * Contrarian-Fix 24.09. (Concurrency/Last): outbound flow protection for the single provider.
 *
 * - Rolling-minute send cap (process-local; `PRIME_JEV_RATE_PER_MIN`, default 60, `0` = off)
 *   keeps bursts inside the documented server limits (250k tok/s, 1.200 req/min) without
 *   serializing the response path like a global concurrency gate would.
 * - Consecutive-failure circuit breaker (`PRIME_JEV_BREAKER_FAILS` default 5,
 *   `PRIME_JEV_BREAKER_COOLDOWN_MS` default 60 s): while open, no request is prepared or
 *   sent — the deterministic path continues (fail-open to the floor, plan §0.7).
 */
export interface FlowGuard {
	isOpen(now?: number): boolean;
	checkRate(now?: number): { ok: true } | { ok: false; retryAfterMs: number };
	onSend(now?: number): void;
	onSuccess(): void;
	onFailure(): void;
	state(): { breakerOpen: boolean; sendsInWindow: number };
}

const MINUTE_MS = 60_000;

function envInt(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export function createFlowGuard(
	options: { env?: Record<string, string | undefined>; now?: () => number } = {},
): FlowGuard {
	const env = options.env ?? process.env;
	const now = options.now ?? (() => Date.now());
	const rateCap = envInt(env.PRIME_JEV_RATE_PER_MIN, 60);
	const breakerFails = envInt(env.PRIME_JEV_BREAKER_FAILS, 5);
	const cooldownMs = envInt(env.PRIME_JEV_BREAKER_COOLDOWN_MS, 60_000);
	const sends: number[] = [];
	let failures = 0;
	let openUntil = 0;

	return {
		isOpen(at = now()) {
			if (breakerFails <= 0) return false;
			return openUntil > at;
		},
		checkRate(at = now()) {
			if (rateCap <= 0) return { ok: true };
			while (sends.length && at - sends[0] >= MINUTE_MS) sends.shift();
			if (sends.length >= rateCap) return { ok: false, retryAfterMs: MINUTE_MS - (at - sends[0]) };
			return { ok: true };
		},
		onSend(at = now()) {
			sends.push(at);
		},
		onSuccess() {
			failures = 0;
			openUntil = 0;
		},
		onFailure() {
			if (breakerFails <= 0) return;
			failures += 1;
			if (failures >= breakerFails) openUntil = now() + cooldownMs;
		},
		state() {
			return { breakerOpen: this.isOpen(), sendsInWindow: sends.length };
		},
	};
}
