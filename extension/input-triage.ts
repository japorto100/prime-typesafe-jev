/** Optional convenience only. Native Prime owns interruption and scheduling. */
export function inputTriageEnabled(env: Record<string, string | undefined>): boolean {
	return env.PRIME_JEV_INPUT_TRIAGE === "advisory";
}

export function advisoryInputHandler(decide: (text: string) => Promise<any>) {
	return async (event: any, ctx: any) => {
		// Do not classify injected extension messages as operator commands.
		if (event?.source !== "interactive" && event?.source !== "rpc") return;
		if (typeof event.text !== "string" || event.images?.length) return;
		const text = event.text.trim();
		if (!text || text.startsWith("/") || Buffer.byteLength(text, "utf8") > 4096) return;
		try {
			const answer = await decide(text);
			if (answer?.mock) return;
			if (answer?.choice === "CONTROL") {
				ctx?.ui?.notify?.("JEV-Hinweis: Zum Unterbrechen Primes native Interrupt-Taste verwenden.", "info");
			} else if (answer?.choice === "EPHEMERAL") {
				ctx?.ui?.notify?.("JEV-Hinweis: /btw eignet sich für unabhängige Zwischenfragen.", "info");
			}
		} catch {
			// Advisory failure must not swallow or redirect input.
		}
		return { action: "continue" as const };
	};
}
