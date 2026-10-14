/**
 * Run binding for asynchronous advisor hooks (Verify-Fix 24.09., Review-Befund F2/F4).
 *
 * A queued job is bound to `(session, run epoch)` at enqueue time.
 *
 * D05 (Audit 26.09.): the epochs are tracked **per session**, not in one global slot.
 * A new agent run (`beginRun`) bumps only its own session; a session boundary
 * (`invalidate`) invalidates only the session it names. Session A's reload/shutdown must
 * never cancel session B's queued work, and a session switch must not re-label foreign
 * jobs. A caller without an identity binds to the unknown-session slot; only an
 * unqualified `invalidate()` (no session at all) clears every slot.
 *
 * The send gate requires the binding to be current; the visible apply (hints) re-checks
 * it once more. Stale results are dropped — they never become hints.
 */
const UNKNOWN_SESSION = "\u0000unknown-session";

export interface RunBinding {
	session: string | null;
	epoch: number;
}

export interface RunContext {
	/** Start of a new agent run (turnIndex resets there) — invalidates queued jobs of that session. */
	beginRun(session?: string | null): void;
	/** Remember the most recently observed session id (fallback for `bind()` without an argument). */
	noteSession(session: string | null): void;
	/** Session boundary / reload / shutdown. Without a session id: every slot is invalidated. */
	invalidate(session?: string | null): void;
	bind(session?: string | null): RunBinding;
	isCurrent(binding: RunBinding): boolean;
}

function keyOf(session: string | null | undefined): string {
	return session === undefined || session === null || session === "" ? UNKNOWN_SESSION : session;
}

export function createRunContext(): RunContext {
	const epochs = new Map<string, number>();
	let noted: string | null = null;
	const epochOf = (key: string): number => epochs.get(key) ?? 0;
	const bump = (key: string): void => {
		epochs.set(key, epochOf(key) + 1);
	};
	return {
		beginRun(session) {
			bump(keyOf(session));
		},
		noteSession(id) {
			if (typeof id === "string" && id) noted = id;
		},
		invalidate(session) {
			if (session === undefined) {
				for (const key of new Set([...epochs.keys(), UNKNOWN_SESSION])) bump(key);
				noted = null;
				return;
			}
			bump(keyOf(session));
			if (noted === session) noted = null;
		},
		bind(session) {
			const key = keyOf(session === undefined ? noted : session);
			return { session: key === UNKNOWN_SESSION ? null : key, epoch: epochOf(key) };
		},
		isCurrent(binding) {
			return epochOf(keyOf(binding.session)) === binding.epoch;
		},
	};
}
