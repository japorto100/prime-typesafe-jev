import { readUpstreamJson } from "../upstream-response.ts";
import { egressMode, redactPayload } from "./redactor.ts";

/** One constant for the upstream abort (R3 — no host timeout exists; hooks reuse this). */
export const JEV_DEADLINE_MS = 1200;
const MAX_REQUEST_BYTES = 64 * 1024;

export interface ProviderCapabilities {
	methods: string[];
	batching: boolean;
	probabilities: boolean;
	legend: boolean;
	usage: boolean;
	modelId: boolean;
	maxQuestions: number;
	maxBytes: number;
	timeoutClass: "fast" | "slow";
	egress: "external" | "local";
	cost: "metered" | "none";
}

export interface ProviderPrepareInput {
	state: unknown;
	questions: Record<string, any>;
	env: Record<string, string | undefined>;
}

/** Prepared (redacted + size-checked) wire request — admission happens on `bytesIn`. */
export interface PreparedRequest {
	body: string;
	bytesIn: number;
	redactions: number;
}

export interface ProviderResult extends PreparedRequest {
	data: any;
	bytesOut: number;
	model: string | null;
}

export interface DecisionProvider {
	id: string;
	capabilities: ProviderCapabilities;
	/** Build the redacted wire body. May throw (egress block / size budget / invalid). */
	prepare(input: ProviderPrepareInput): PreparedRequest;
	/** Send a prepared request; sanitizes errors, bounds the response. */
	send(prepared: PreparedRequest, apiKey: string): Promise<{ data: any; bytesOut: number; model: string | null }>;
	/** Convenience: prepare + send (public API path without admission). */
	decide(request: {
		state: unknown;
		questions: Record<string, any>;
		apiKey: string;
		env: Record<string, string | undefined>;
	}): Promise<ProviderResult>;
}

export const jevProvider: DecisionProvider = {
	id: "jev",
	capabilities: {
		methods: ["choice", "score", "noul"],
		batching: true,
		probabilities: true,
		legend: true,
		usage: true,
		modelId: true,
		maxQuestions: 64,
		maxBytes: MAX_REQUEST_BYTES,
		timeoutClass: "fast",
		egress: "external",
		cost: "metered",
	},
	prepare({ state, questions, env }) {
		const model = env.PRIME_JEV_MODEL?.trim() || "jev-latest";
		if (!/^jev-[A-Za-z0-9._-]{1,72}$/.test(model)) {
			throw new Error("JevModelInvalid: expected an explicit Jev model identifier");
		}
		const upstreamPayload = { model, state, questions };
		const mode = egressMode(env);
		// F01: redact the structured payload, then serialize — the wire body stays valid JSON.
		const redacted = mode === "off" ? { value: upstreamPayload, redactions: 0 } : redactPayload(upstreamPayload);
		if (mode === "block" && redacted.redactions > 0) {
			throw new Error("JevEgressBlocked: outbound request contains redactable secrets");
		}
		const body = JSON.stringify(redacted.value);
		const bytesIn = Buffer.byteLength(body, "utf8");
		if (bytesIn > MAX_REQUEST_BYTES) {
			throw new Error("JevRequestTooLarge: serialized request exceeds local 64 KiB budget");
		}
		return { body, bytesIn, redactions: redacted.redactions };
	},
	async send(prepared, apiKey) {
		const started = Date.now();
		let attempt = 0;
		for (;;) {
			const remaining = JEV_DEADLINE_MS - (Date.now() - started);
			if (remaining <= 250) throw new Error("TypeSafe API Error (deadline exhausted)");
			const upstreamResp = await fetch("https://api.typesafe.ai/v1/systemone", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					"User-Agent": "prime-agent-typesafe-bridge/1.0",
				},
				body: prepared.body,
				signal: AbortSignal.timeout(remaining),
			});
			if (upstreamResp.ok) {
				const data = await readUpstreamJson(upstreamResp);
				return {
					data,
					bytesOut: Buffer.byteLength(JSON.stringify(data ?? null), "utf8"),
					model: typeof data?.model === "string" ? data.model : null,
				};
			}
			// Release the upstream connection without reading or reflecting private error bodies.
			// Never reflect an upstream body: it can echo credentials or private context.
			try {
				await upstreamResp.body?.cancel();
			} catch {
				/* preserve status below */
			}
			// Contrarian-Fix 24.09.: docs expect backoff on 429/529 — ONE bounded retry within the
			// same deadline (honors Retry-After up to 400 ms), still no unbounded retry loop.
			if ((upstreamResp.status === 429 || upstreamResp.status === 529) && attempt === 0) {
				const retryAfter = Number(upstreamResp.headers.get("retry-after"));
				const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 400) : 150;
				attempt += 1;
				await new Promise((resolve) => setTimeout(resolve, wait));
				continue;
			}
			const error = new Error(`TypeSafe API Error (Status ${upstreamResp.status})`);
			if (upstreamResp.status === 429 || upstreamResp.status === 529) error.name = "JevOverloaded";
			throw error;
		}
	},
	async decide({ state, questions, apiKey, env }) {
		const prepared = this.prepare({ state, questions, env });
		const sent = await this.send(prepared, apiKey);
		return { ...prepared, ...sent };
	},
};

const PROVIDERS = new Map<string, DecisionProvider>([[jevProvider.id, jevProvider]]);

/** Exactly one provider today (`jev`); the seam exists so a second one must justify itself. */
export function activeProvider(env: Record<string, string | undefined> = process.env): DecisionProvider {
	const id = env.PRIME_JEV_PROVIDER?.trim() || "jev";
	const provider = PROVIDERS.get(id);
	if (!provider) throw new Error(`JevProviderUnknown: ${id}`);
	return provider;
}

/** Capability gate: a provider without the capability must never be asked for it. */
export function assertProviderSupports(provider: DecisionProvider, method: string): void {
	const supported =
		method === "system_one" ? provider.capabilities.batching : provider.capabilities.methods.includes(method);
	if (!supported) throw new Error(`JevProviderUnsupported: ${provider.id} cannot answer ${method}`);
}
