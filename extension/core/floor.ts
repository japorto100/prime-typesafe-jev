/**
 * J01: deterministic tool floor for the host.
 *
 * Two tiers by design (Contrarian F5): `block` only for unambiguous imperative
 * patterns with action+target co-occurrence; `warn` for grey zones (host decides
 * HITL/headless). This is a tripwire, NOT a security boundary — string
 * construction evades any regex, and the corpus test documents that honestly.
 */
export type FloorKind = "allow" | "warn" | "block";

export interface FloorVerdict {
	kind: FloorKind;
	rule: string;
}

const HARD_BASH: Array<[string, RegExp]> = [
	["rm-recursive-force", /\brm\s+.*(-[a-z]*[rf][a-z]*|--recursive|--force).*\s+([/~]|\.\/|--\s+[/~])/i],
	["mkfs", /\bmkfs\b/],
	["dd-raw-device", /\bdd\b[^\n]*\b(?:of|if)=\/dev\/(?:sd|nvme|mmcblk|vd|disk|loop|mapper)/],
	["drop-table", /\bDROP\s+TABLE\b/i],
	["git-push-force", /\bgit\s+push\b[^\n]*(-f\b|--force)/],
	["kill-init", /\bkill\s+-9\s+1\b/],
];

const SOFT_BASH: Array<[string, RegExp]> = [
	["rm", /\brm\s+/],
	["git-reset-hard", /\bgit\s+reset\s+--hard\b/],
	["chmod-777", /\bchmod\s+.*777\b/],
];

const HARD_IPYTHON: Array<[string, RegExp]> = [
	["rmtree-root", /shutil\.rmtree\s*\(\s*['"](?:\/|~)/],
	[
		"shell-destructive",
		/(?:os\.system|os\.popen|subprocess\.[A-Za-z_]+)\s*\([^\n]*?(?:rm\s+-[a-z]*[rf]|dd\b[^\n]*\bof=\/dev\/|mkfs\b)/,
	],
	["dd-raw-device", /dd\b[^\n]*\b(?:of|if)=\/dev\/(?:sd|nvme|mmcblk|vd|disk|loop|mapper)/],
	["git-push-force", /git\s+push\b[^\n]*(-f\b|--force)/],
	["kill-init", /\bkill\s+-9\s+1\b/],
];

const SOFT_IPYTHON: Array<[string, RegExp]> = [
	["rmtree", /shutil\.rmtree\s*\(/],
	["os-remove-absolute", /os\.(?:remove|unlink|rmdir)\s*\(\s*['"]\//],
	["chmod-777", /\.chmod\s*\([^)]*777/],
];

function evaluate(text: string, hard: Array<[string, RegExp]>, soft: Array<[string, RegExp]>): FloorVerdict {
	for (const [rule, pattern] of hard) if (pattern.test(text)) return { kind: "block", rule };
	for (const [rule, pattern] of soft) if (pattern.test(text)) return { kind: "warn", rule };
	return { kind: "allow", rule: "" };
}

/**
 * Verify-Fix 24.09.: a mention is not an action. Quoted literals and comments are masked
 * for the `dd` rule; a raw mention downgrades to `warn` instead of a hard block. The
 * imperative shells (`os.system`, `subprocess.*`, `!`-escape) are caught unmasked by
 * `shell-destructive` or stay visible outside quotes.
 */
function maskLiteralsAndComments(text: string): string {
	return text
		.replace(/'(?:[^'\\]|\\.)*'/gs, '""')
		.replace(/"(?:[^"\\]|\\.)*"/gs, '""')
		.replace(/(^|\s)#[^\n]*/g, "$1");
}

const DD_RULE = "dd-raw-device";

function ddPatternOf(hard: Array<[string, RegExp]>): RegExp {
	return hard.find(([rule]) => rule === DD_RULE)?.[1] ?? /$^/;
}

function evaluateWithMentionTier(
	text: string,
	hard: Array<[string, RegExp]>,
	soft: Array<[string, RegExp]>,
): FloorVerdict {
	const masked = maskLiteralsAndComments(text);
	const dd = ddPatternOf(hard);
	for (const [rule, pattern] of hard) {
		if (rule === DD_RULE) continue;
		if (pattern.test(text)) return { kind: "block", rule };
	}
	if (dd.test(masked)) return { kind: "block", rule: DD_RULE };
	if (dd.test(text)) return { kind: "warn", rule: "dd-mention" };
	for (const [rule, pattern] of soft) if (pattern.test(text)) return { kind: "warn", rule };
	return { kind: "allow", rule: "" };
}

export function evaluateBashFloor(command: string): FloorVerdict {
	return command.includes("dd")
		? evaluateWithMentionTier(command, HARD_BASH, SOFT_BASH)
		: evaluate(command, HARD_BASH, SOFT_BASH);
}

export function evaluateIpythonFloor(code: string): FloorVerdict {
	return code.includes("dd")
		? evaluateWithMentionTier(code, HARD_IPYTHON, SOFT_IPYTHON)
		: evaluate(code, HARD_IPYTHON, SOFT_IPYTHON);
}
