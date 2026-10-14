import fs from "node:fs";
import path from "node:path";

export type ReceiptOrigin = "automatic_hook" | "explicit_python" | "operator_test" | "unknown";
export type ReceiptOutcome = "answered" | "unknown" | "timeout" | "error" | "skipped";

/** D14: async queue load contract, recorded with the call it admitted (counters, not payloads). */
export interface QueueSnapshot {
	active: number;
	pending: number;
	retainedBytes: number;
	admitted: number;
	dropped: number;
	coalesced: number;
	expired: number;
	gated: number;
}

export interface ReceiptExtras {
	hook?: string;
	mode?: string;
	origin?: ReceiptOrigin;
	outcome?: ReceiptOutcome;
	questions_version?: string | null;
	provider?: string | null;
	bytes_in?: number | null;
	bytes_out?: number | null;
	truncated?: boolean;
	redactions?: number;
	would?: string | null;
	/** J20: predicted action at decision time (tool-gate; `none` in shadow/advisory). */
	would_action?: string | null;
	session?: string | null;
	turn?: number | null;
	decision_id?: string | null;
	/** Queue state of the calling hook's async-lifecycle runner at decision time. */
	queue?: QueueSnapshot | null;
}

/**
 * v2 = additive superset of v1 (all v1 fields stay, incl. `model` for drift detection).
 * Still intentionally no prompts, questions, answers, credentials or raw errors —
 * measurement values live in the separate eval channel (`prime-jev/eval/1`).
 */
export function callReceipt(
	request: any,
	result: any,
	status: "success" | "error",
	elapsedMs: number,
	extras: ReceiptExtras = {},
) {
	const rawDepth = request?.caller?.reported_depth;
	const depth = typeof rawDepth === "string" && /^\d{1,2}$/.test(rawDepth) ? Number(rawDepth) : null;
	const pid = request?.caller?.pid;
	const method = ["choice", "score", "noul", "system_one"].includes(request?.method) ? request.method : "unknown";
	return {
		schema: "prime-jev/call/2",
		at: new Date().toISOString(),
		host_pid: process.pid,
		reported_client_pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
		reported_depth: depth,
		origin_attested: false,
		method,
		question_count: method === "system_one" ? Object.keys(request?.params?.questions ?? {}).length : 1,
		status,
		elapsed_ms: Math.max(0, Math.round(elapsedMs)),
		model: typeof result?.model === "string" && /^[a-zA-Z0-9._-]{1,80}$/.test(result.model) ? result.model : null,
		hook: extras.hook ?? "unknown",
		mode: extras.mode ?? "live",
		origin: extras.origin ?? "unknown",
		outcome: extras.outcome ?? (status === "success" ? "answered" : "error"),
		questions_version: extras.questions_version ?? null,
		provider: extras.provider ?? null,
		bytes_in: typeof extras.bytes_in === "number" ? extras.bytes_in : null,
		bytes_out: typeof extras.bytes_out === "number" ? extras.bytes_out : null,
		truncated: extras.truncated === true,
		redactions: typeof extras.redactions === "number" ? extras.redactions : 0,
		would: extras.would ?? null,
		would_action: extras.would_action ?? null,
		session: extras.session ?? null,
		turn: typeof extras.turn === "number" ? extras.turn : null,
		decision_id: extras.decision_id ?? null,
		queue: extras.queue ?? null,
	};
}

/** Union reader for v1 and v2 rows — v1 consumers keep working on the additive base. */
export function normalizeReceipt(row: any) {
	const schema = typeof row?.schema === "string" ? row.schema : "unknown";
	const isV2 = schema === "prime-jev/call/2";
	return {
		schema,
		at: row?.at ?? null,
		host_pid: row?.host_pid ?? null,
		method: row?.method ?? "unknown",
		status: row?.status ?? "error",
		elapsed_ms: typeof row?.elapsed_ms === "number" ? row.elapsed_ms : null,
		model: row?.model ?? null,
		hook: isV2 ? row.hook : "unknown",
		mode: isV2 ? row.mode : "live",
		origin: isV2 ? row.origin : "unknown",
		outcome: isV2 ? row.outcome : row?.status === "success" ? "answered" : "error",
		provider: isV2 ? row.provider : null,
		bytes_in: isV2 ? row.bytes_in : null,
		bytes_out: isV2 ? row.bytes_out : null,
		redactions: isV2 ? row.redactions : 0,
		decision_id: isV2 ? (row.decision_id ?? null) : null,
	};
}

export function appendCallReceipt(file: string, row: ReturnType<typeof callReceipt>): boolean {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		fs.appendFileSync(file, JSON.stringify(row) + "\n", { mode: 0o600 });
		return true;
	} catch {
		return false;
	}
}
