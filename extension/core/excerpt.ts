import { createHash } from "node:crypto";

/**
 * Excerpt capping with provenance (Verify-Fix 24.09., §4 "Digest-Header"):
 * when the excerpt is cut, the full text never travels — but a 16-hex digest of the
 * source text rides along, so the measurement stays attributable without the content.
 */
export interface Excerpt {
	excerpt: string;
	digest: string | null;
	truncated: boolean;
}

export function excerptOf(text: string, maxChars: number): Excerpt {
	if (text.length <= maxChars) return { excerpt: text, digest: null, truncated: false };
	return {
		excerpt: text.slice(0, maxChars),
		digest: createHash("sha256").update(text).digest("hex").slice(0, 16),
		truncated: true,
	};
}
