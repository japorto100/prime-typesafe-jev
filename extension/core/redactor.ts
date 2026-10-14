/**
 * J10: technical egress redaction (not just prose policy). Default `redact`; `block`
 * refuses the request when anything matched; `off` is an explicit escape hatch.
 * Only counts travel into receipts — never matched text.
 *
 * F01 (Review 24.09.): redaction runs on the STRUCTURED payload before serialization.
 * The old string-level pass (a) re-inserted the marker in front of a still-present
 * Bearer token and (b) could turn serialized JSON invalid by removing value quotes.
 */
export type EgressMode = "redact" | "block" | "off";

export function egressMode(env: Record<string, string | undefined> = process.env): EgressMode {
	const value = env.PRIME_JEV_EGRESS;
	if (value === "block" || value === "off") return value;
	return "redact";
}

interface RedactionRule {
	id: string;
	pattern: RegExp;
	replace: (match: string, groups: string[]) => string;
}

const RULES: RedactionRule[] = [
	{
		id: "private-key",
		pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
		replace: () => "[REDACTED]",
	},
	{
		id: "bearer",
		// Replace the WHOLE match — the token must disappear, not just the prefix (F01).
		pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
		replace: () => "Bearer [REDACTED]",
	},
	{
		id: "prefixed-token",
		pattern: /\b(?:sk|pk|rk|ghp|gho|ghs|glpat|npm|xox[abprs])[-_][A-Za-z0-9_-]{12,}\b/g,
		replace: () => "[REDACTED]",
	},
	{
		id: "path-deny",
		// §4 path deny: `.env*`, `auth.json`, `.ssh/**`, `*.pem` never leave the host.
		// Redaction (not just denial) so the rest of the excerpt stays measurable.
		pattern:
			/(?<![\w.~-])(?:(?:[\w.~-]|\/)*\/)?(?:\.env(?:\.[\w-]+)?|auth\.json|[\w.-]+\.pem|\.ssh\/[^\s"'`<>;,)]+)(?![\w-])/g,
		replace: () => "[REDACTED:path]",
	},
	{
		id: "aws-access-key",
		pattern: /\bAKIA[0-9A-Z]{16}\b/g,
		replace: () => "[REDACTED]",
	},
	{
		id: "assignment",
		pattern:
			/((?:api[_-]?key|apikey|secret|token|password|passwd|pwd)["']?\s*[:=]\s*)("[^"]{6,}"|'[^']{6,}'|[A-Za-z0-9._~+/-]{12,})/gi,
		replace: (_match, groups) => `${groups[0]}[REDACTED]`,
	},
	{
		id: "url-credentials",
		// Scheme length is bounded ({0,31}) so a long run without :// cannot backtrack quadratically.
		pattern: /([a-z][a-z0-9+.-]{0,31}:\/\/[^/\s:@]+:)[^@\s/]+(@)/gi,
		replace: (_match, groups) => `${groups[0]}[REDACTED]${groups[1]}`,
	},
];

function redactString(text: string): { text: string; redactions: number } {
	let redactions = 0;
	let output = text;
	for (const rule of RULES) {
		output = output.replace(rule.pattern, (...args: any[]) => {
			redactions += 1;
			return rule.replace(args[0], args.slice(1, -2));
		});
	}
	return { text: output, redactions };
}

/** Plain-text helper (fields, logs, tests) — structure-preserving redaction is `redactPayload`. */
export function redactBody(body: string): { body: string; redactions: number } {
	const { text, redactions } = redactString(body);
	return { body: text, redactions };
}

const SENSITIVE_KEY =
	/^(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|auth|authorization|credentials?|private[_-]?key|access[_-]?key)$/i;

/**
 * Structure-preserving redaction: walk the payload, redact string VALUES only.
 * Keys and JSON structure survive, so `JSON.stringify(result.value)` is always valid.
 * A string under a sensitive KEY is replaced regardless of its content (F01).
 */
export function redactPayload(value: unknown): { value: unknown; redactions: number } {
	let redactions = 0;
	const walk = (node: unknown, key?: string): unknown => {
		if (typeof node === "string") {
			if (key && SENSITIVE_KEY.test(key)) {
				if (node !== "[REDACTED]") redactions += 1;
				return "[REDACTED]";
			}
			const result = redactString(node);
			redactions += result.redactions;
			return result.text;
		}
		if (Array.isArray(node)) return node.map((child) => walk(child));
		if (node && typeof node === "object") {
			const output: Record<string, unknown> = {};
			for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) {
				output[childKey] = walk(child, childKey);
			}
			return output;
		}
		return node;
	};
	return { value: walk(value), redactions };
}
