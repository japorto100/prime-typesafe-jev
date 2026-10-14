import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveAgentDir } from "./agent-dir.ts";

/**
 * Paket B (Review 24.09., J7): hard budget contract.
 * P01 (29.09.): fail-closed persistence (validated counters/date, tempfile+fsync+rename).
 * Policy B / JEV-06/07 (29.09./30.09.): reservation-bound refunds.
 *
 * - `reserve(hook, bytes)` admits or denies ATOMICALLY via a locked read-modify-write of
 *   the persistent day file and returns a **reservation handle** (id, hook, bytes, day).
 * - `send(reservation)` confirms the send (hook quota moves reserved -> sent, entry drops).
 * - `release(reservation)` refunds a reservation that never resulted in a send; it is bound
 *   to the reservation id (double-release / release-after-send / foreign-day => no-op, never
 *   a debit of another reservation). Lock/persistence failures are propagated as
 *   `"unavailable"` — never a silent no-op.
 * - Day caps are persistent and survive restarts; the day window rotates on access.
 * - Hook quota is authoritative in the persistent state (`sent + reserved` per day).
 * - Denied attempts are counted with `noteSkipped` (kept separate from sent quota).
 * - Active reservations are bounded (MAX_ACTIVE); completed ones drop immediately, so the
 *   state file stays small (<= 4096 bytes, v1-readable for rollback).
 * - Root counters are per-process by construction (a root task lives in this process);
 *   the persistent hard cap is the day cap.
 */
export interface BudgetPolicy {
	rootCalls: number;
	perHook: Record<string, number>;
	rootBytes: number;
	dayCalls: number;
	dayBytes: number;
}

export const DEFAULT_BUDGET_POLICY: BudgetPolicy = {
	rootCalls: 200,
	// Per-task hook caps (A2 ≤1/Task, A4 ≤2/Turn, …) are enforced by the hooks' own
	// dedupe/binding logic; the budget enforces root/day/byte ceilings globally.
	perHook: {
		"input-triage": 50,
	},
	rootBytes: 512 * 1024,
	dayCalls: 1000,
	dayBytes: 5 * 1024 * 1024,
};

export interface BudgetSummary {
	rootCalls: number;
	rootBytes: number;
	dayCalls: number;
	dayBytes: number;
	skippedCalls: number;
	hookCalls: Record<string, number>;
}

export interface Reservation {
	id: string;
	hook: string;
	bytes: number;
	day: string;
}

export type SendStatus = "sent" | "noop" | "unavailable";
export type ReleaseStatus = "refunded" | "noop" | "unavailable";

export interface BudgetHandle {
	/** Atomic admission + reservation of `bytes` for `hook`. `null` ⇒ denied (call `noteSkipped`). */
	reserve(hook: string, bytes: number): Reservation | null;
	/** Confirm a successful send (hook quota: reserved -> sent; entry drops). */
	send(reservation: Reservation): SendStatus;
	/** Refund a reservation that never resulted in a send; id-bound and idempotent. */
	release(reservation: Reservation): ReleaseStatus;
	/** Count a denied/skipped attempt (separate from sent quota). False ⇒ not persisted. */
	noteSkipped(hook: string): boolean;
	summary(): BudgetSummary;
}

interface HookCounts {
	sent: number;
	reserved: number;
}

interface ReservationEntry {
	id: string;
	hook: string;
	bytes: number;
	created: number;
}

interface DayState {
	day: string;
	calls: number;
	bytes: number;
	skipped: number;
	revision: number;
	hooks: Record<string, HookCounts>;
	active: ReservationEntry[];
}

const MAX_STATE_BYTES = 4096;
const MAX_ACTIVE = 24;
const LOCK_STALE_MS = 5000;
const LOCK_RETRY_MS = 10;
const LOCK_RETRIES = 50;

function todayKey(now: Date): string {
	return now.toISOString().slice(0, 10);
}

function freshState(now: Date, revision = 0): DayState {
	return { day: todayKey(now), calls: 0, bytes: 0, skipped: 0, revision, hooks: {}, active: [] };
}

function isCounter(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readDayFile(file: string, now: Date): DayState {
	let raw: string;
	try {
		const handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
		try {
			const stat = fs.fstatSync(handle);
			if (!stat.isFile() || stat.size > MAX_STATE_BYTES) throw new Error("JevBudgetUnavailable: invalid state file");
			raw = fs.readFileSync(handle, "utf8");
		} finally {
			fs.closeSync(handle);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return freshState(now);
		throw new Error("JevBudgetUnavailable: state cannot be read safely");
	}
	let parsed: any;
	try { parsed = JSON.parse(raw); } catch { throw new Error("JevBudgetUnavailable: malformed state"); }
	const day = parsed?.day;
	const timestamp = typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day)
		? Date.parse(`${day}T00:00:00Z`) : NaN;
	// Older valid state may omit skipped; spent calls/bytes must never be guessed.
	const skipped = parsed?.skipped ?? 0;
	const revision = parsed?.revision ?? 0;
	if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== day ||
		day > todayKey(now) || !isCounter(parsed?.calls) || !isCounter(parsed?.bytes) || !isCounter(skipped) || !isCounter(revision)) {
		throw new Error("JevBudgetUnavailable: invalid counters or date");
	}
	// v2 fields are optional (v1 migration): validate when present.
	const hooks: Record<string, HookCounts> = {};
	if (parsed?.hooks !== undefined) {
		if (typeof parsed.hooks !== "object" || parsed.hooks === null || Array.isArray(parsed.hooks)) {
			throw new Error("JevBudgetUnavailable: invalid hook counters");
		}
		for (const [name, value] of Object.entries<any>(parsed.hooks)) {
			if (!name || typeof value !== "object" || value === null ||
				!isCounter(value.sent) || !isCounter(value.reserved)) {
				throw new Error("JevBudgetUnavailable: invalid hook counters");
			}
			if (value.sent > 0 || value.reserved > 0) hooks[name] = { sent: value.sent, reserved: value.reserved };
		}
	}
	const active: ReservationEntry[] = [];
	if (parsed?.active !== undefined) {
		if (!Array.isArray(parsed.active) || parsed.active.length > 256) {
			throw new Error("JevBudgetUnavailable: invalid reservation list");
		}
		for (const entry of parsed.active as any[]) {
			if (typeof entry !== "object" || entry === null ||
				typeof entry.id !== "string" || !entry.id || entry.id.length > 64 ||
				typeof entry.hook !== "string" || !entry.hook || entry.hook.length > 64 ||
				!isCounter(entry.bytes) || !isCounter(entry.created)) {
				throw new Error("JevBudgetUnavailable: invalid reservation entry");
			}
			active.push({ id: entry.id, hook: entry.hook, bytes: entry.bytes, created: entry.created });
		}
	}
	if (day !== todayKey(now)) return freshState(now, revision);
	return { day, calls: parsed.calls, bytes: parsed.bytes, skipped, revision, hooks, active };
}

function serializeState(state: DayState): string {
	const hooks: Record<string, HookCounts> = {};
	for (const [name, value] of Object.entries(state.hooks)) {
		if (value.sent > 0 || value.reserved > 0) hooks[name] = { sent: value.sent, reserved: value.reserved };
	}
	const payload = {
		v: 2,
		day: state.day,
		calls: state.calls,
		bytes: state.bytes,
		skipped: state.skipped,
		revision: state.revision,
		hooks,
		active: state.active,
	};
	return JSON.stringify(payload) + "\n";
}

function writeDayFile(file: string, state: DayState): void {
	const body = serializeState(state);
	if (Buffer.byteLength(body, "utf8") > MAX_STATE_BYTES) {
		// Bounded state is part of the contract (rollback-readable, small file). Fail closed.
		throw new Error("JevBudgetUnavailable: state would exceed size bound");
	}
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
	let handle: number | undefined;
	try {
		handle = fs.openSync(temp, "wx", 0o600);
		fs.writeFileSync(handle, body);
		fs.fsyncSync(handle);
		fs.closeSync(handle);
		handle = undefined;
		fs.renameSync(temp, file);
	} finally {
		if (handle !== undefined) fs.closeSync(handle);
		try { fs.unlinkSync(temp); } catch { /* moved or absent */ }
	}
	// Failure propagates to withFileLock: no persisted reservation means no admission.
}

/** Cross-process lock for the read-modify-write admission (bounded, stale-cleaning). */
function withFileLock<T>(file: string, action: () => T): T | null {
	const lock = `${file}.lock`;
	for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
			const handle = fs.openSync(lock, "wx", 0o600);
			try {
				return action();
			} finally {
				fs.closeSync(handle);
				try {
					fs.unlinkSync(lock);
				} catch {
					/* already gone */
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
			try {
				if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
					fs.unlinkSync(lock);
					continue;
				}
			} catch {
				continue; // lock vanished — retry immediately
			}
			const until = Date.now() + LOCK_RETRY_MS;
			while (Date.now() < until) {
				/* bounded wait before retry */
			}
		}
	}
	return null;
}

export function createBudget(options: {
	rootId: string;
	file?: string;
	policy?: BudgetPolicy;
	env?: Record<string, string | undefined>;
	now?: () => Date;
}): BudgetHandle {
	const policy = options.policy ?? DEFAULT_BUDGET_POLICY;
	const env = options.env ?? process.env;
	const now = options.now ?? (() => new Date());
	// WP2 (25.09.): State-Klasse — neu schreiben, beim ersten Lauf Altstand lesen (Zähler übernehmen).
	const file = options.file ?? path.join(resolveAgentDir(env), "receipts", "jev.budget.json");
	const legacyFile = options.file ?? path.join(resolveAgentDir(env), "harness", "jev-budget.json");
	/** Alt → neu für State: neuen Pfad bevorzugen, sonst den alten einmalig übernehmen. */
	const readCurrent = (): DayState => {
		if (fs.existsSync(file)) return readDayFile(file, now());
		if (legacyFile !== file && fs.existsSync(legacyFile)) return readDayFile(legacyFile, now());
		return readDayFile(file, now());
	};
	void options.rootId; // root counters are per-process by construction (documented above)
	let rootCalls = 0;
	let rootBytes = 0;

	/**
	 * Locked read-modify-write. Returns the action result, or `null` when the lock or the
	 * persistence failed (callers must surface that; never treat it as success).
	 */
	const mutateDay = <T>(mutate: (state: DayState) => T | null): T | null => {
		return withFileLock(file, () => {
			const state = readCurrent();
			const result = mutate(state);
			if (result === null) return null;
			state.revision += 1;
			writeDayFile(file, state);
			// Stolen-lock guard: verify our write actually landed at the expected revision.
			const reread = readDayFile(file, now());
			if (reread.revision !== state.revision) {
				throw new Error("JevBudgetUnavailable: concurrent state write detected");
			}
			return result;
		});
	};

	const findEntry = (state: DayState, id: string): number => state.active.findIndex((entry) => entry.id === id);

	return {
		reserve(hook: string, bytes: number): Reservation | null {
			const size = Number.isFinite(bytes) ? Math.max(0, Math.round(bytes)) : 0;
			if (env.PRIME_JEV_BUDGET_KILL === "1") return null; // dynamic kill switch
			if (rootCalls >= policy.rootCalls || rootBytes + size > policy.rootBytes) return null;
			const reservation = mutateDay<Reservation | null>((state) => {
				const hookCap = policy.perHook[hook];
				const current = state.hooks[hook] ?? { sent: 0, reserved: 0 };
				if (hookCap !== undefined && current.sent + current.reserved >= hookCap) return null;
				if (state.calls + 1 > policy.dayCalls || state.bytes + size > policy.dayBytes) return null;
				if (state.active.length >= MAX_ACTIVE) return null;
				state.calls += 1;
				state.bytes += size;
				state.hooks[hook] = { sent: current.sent, reserved: current.reserved + 1 };
				const entry: ReservationEntry = { id: randomUUID(), hook, bytes: size, created: Math.floor(now().getTime() / 1000) };
				state.active.push(entry);
				return { id: entry.id, hook, bytes: size, day: state.day };
			});
			if (!reservation) return null;
			rootCalls += 1;
			rootBytes += size;
			return reservation;
		},
		send(reservation: Reservation): SendStatus {
			const status = mutateDay<SendStatus>((state) => {
				const index = findEntry(state, reservation.id);
				if (index === -1) return "noop"; // already sent/refunded, or state rotated
				state.active.splice(index, 1);
				const current = state.hooks[reservation.hook] ?? { sent: 0, reserved: 0 };
				state.hooks[reservation.hook] = { sent: current.sent + 1, reserved: Math.max(0, current.reserved - 1) };
				return "sent";
			});
			return status ?? "unavailable";
		},
		release(reservation: Reservation): ReleaseStatus {
			const status = mutateDay<ReleaseStatus>((state) => {
				const index = findEntry(state, reservation.id);
				if (index === -1) return "noop"; // foreign day / double release / release after send
				const [entry] = state.active.splice(index, 1);
				state.calls = Math.max(0, state.calls - 1);
				state.bytes = Math.max(0, state.bytes - entry.bytes);
				const current = state.hooks[entry.hook] ?? { sent: 0, reserved: 0 };
				state.hooks[entry.hook] = { sent: current.sent, reserved: Math.max(0, current.reserved - 1) };
				return "refunded";
			});
			if (status === "refunded") {
				rootCalls = Math.max(0, rootCalls - 1);
				rootBytes = Math.max(0, rootBytes - reservation.bytes);
			}
			return status ?? "unavailable";
		},
		noteSkipped(_hook: string): boolean {
			const done = mutateDay<boolean>((state) => {
				state.skipped += 1;
				return true;
			});
			return done === true;
		},
		summary(): BudgetSummary {
			const state = readCurrent();
			const hookCalls: Record<string, number> = {};
			for (const [name, value] of Object.entries(state.hooks)) {
				if (value.sent + value.reserved > 0) hookCalls[name] = value.sent + value.reserved;
			}
			return {
				rootCalls,
				rootBytes,
				dayCalls: state.calls,
				dayBytes: state.bytes,
				skippedCalls: state.skipped,
				hookCalls,
			};
		},
	};
}
