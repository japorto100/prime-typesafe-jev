/**
 * Vendored copy — Herkunft und Generation (nicht editieren; erst upstream ändern, dann neu vendorn).
 *
 * Quelle: `extensions/_shared/host-contract/agent-dir.ts` (staging-only Upstream; API und
 * Vendoring-Auflagen stehen im README des dortigen host-contract-Ordners).
 * Generation: Agent-Dir-Contract 25.09.2026 (prime-agent 0.9.6 `dist/config.js`), gepinnt auf die
 * Upstream-Bytes sha256
 * `5fd177c6454c749b43b76c54d55c3242af72c1c24037c6020bbef94fd3aae6a0`.
 *
 * Diese Datei ist bodygleich zur Quelle; dieser Kopf ist der einzige Zusatz. Der Vergleich läuft
 * über `extensions/check-lib-drift.mjs`; der Kopf ist vom Body-Vergleich ausgenommen, Quellname
 * und Pin werden gegen die vollen Upstream-Bytes geprüft.
 *
 * Verbraucher: typesafe-bridge / JEV (nur Import-Ziel des vendorten Resolvers)
 *
 * @vendored-from _shared/host-contract/agent-dir.ts
 * @vendored-sha256 5fd177c6454c749b43b76c54d55c3242af72c1c24037c6020bbef94fd3aae6a0
 */
/**
 * Wo Primes Agent-Dir liegt — eine Antwort für alle Extensions, und dieselbe wie die des Hosts.
 *
 * **Warum das eine eigene Datei ist.** Am 10.09.2026 gab es davon vier Fassungen: in
 * `prime-lab-harness` (fragt zuerst Prime, dann die Umgebung), in `prime-lab-roles`
 * (`resolveAgentDir`, nur Umgebung), in `harness-reader-v3` und in `refinement-proposal-v2`
 * (beide `agentDirFromEnv`). Vier Kopien einer Ortsangabe sind vier Gelegenheiten
 * auseinanderzulaufen, und genau das war passiert: `prime-lab-spill` hatte gar keine und fiel
 * deshalb auf `tmpdir()` zurück. Ergebnis, gemessen: 69 Quittungen aus vierzehn Stunden echter
 * Sitzung lagen unter `/tmp`, vermischt mit denen jedes Testlaufs derselben Maschine — während im
 * Plan stand, die Fähigkeit habe „nie live gefeuert". Sie hatte.
 *
 * **Warum zuerst Prime gefragt wird.** `getAgentDir()` ist die Funktion, mit der der Host selbst
 * entscheidet, wohin er schreibt. Wer für einen Quittungspfad etwas anderes rechnet, kann nur
 * verlieren: eine Abweichung fällt nicht als Fehler auf, sondern als eine Datei, die niemand
 * findet. Die Umgebungsauflösung darunter ist der Notweg für Aufrufe außerhalb eines geladenen
 * Prime (Tests, Werkzeuge) — sie bildet `getAgentDir` nach, inklusive der Tilde-Ausschreibung,
 * die Prime vornimmt.
 *
 * Die drei anderen Fassungen bleiben vorerst, wo sie sind: kein Umzug ohne Anlass. Wer eine davon
 * anfasst, ersetzt sie durch diesen Import.
 */

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Primes eigenes `getAgentDir`, wenn es erreichbar ist — geholt zur Laufzeit, nicht als Import.
 *
 * Ein statisches `import … from "@earendil-works/pi-coding-agent"` wäre die schönere Zeile und war
 * die erste Fassung. Sie hat drei Testdateien auf einen Schlag rot gemacht:
 * `ERR_MODULE_NOT_FOUND`, weil `node --test` das Paket nicht auflöst — der Grund, aus dem
 * `host-contract/prime-aliases.mjs` überhaupt existiert. Ein geteiltes Modul darf nicht
 * voraussetzen, dass jeder Aufrufer daran gedacht hat: was hier importiert wird, importiert jede
 * Extension mit, die es benutzt, und jeder ihrer Tests.
 *
 * `createRequire` löst synchron auf (die Funktion bleibt synchron) und wirft in einem `try`, das
 * die Antwort einmal merkt — auch die negative, damit nicht jeder Aufruf erneut sucht.
 */
let primeAgentDir: (() => string) | null | undefined;

function hostResolver(): (() => string) | null {
	if (primeAgentDir !== undefined) return primeAgentDir;
	let resolved: (() => string) | null = null;
	try {
		const require_ = createRequire(import.meta.url);
		const host = require_("@earendil-works/pi-coding-agent");
		if (typeof host?.getAgentDir === "function") resolved = host.getAgentDir;
	} catch {
		resolved = null;
	}
	primeAgentDir = resolved;
	return resolved;
}

/**
 * Das Agent-Dir dieser Sitzung.
 *
 * `env` ist injizierbar, damit ein Test den Notweg prüfen kann, ohne einen Prime-Prozess zu
 * brauchen. Im Betrieb greift der erste Zweig.
 */
export function agentDir(env: Record<string, string | undefined> = process.env): string {
	const resolver = hostResolver();
	if (resolver) {
		try {
			return resolver();
		} catch {
			// Prime ist da, weiß es aber selbst nicht (kein geladener Agent) — Notweg.
		}
	}
	return agentDirFromEnv(env);
}

/** Nur der Notweg, ohne Host — was `PRIME_AGENT_CODING_AGENT_DIR` sagt, sonst `~/.prime/agent`. */
export function agentDirFromEnv(env: Record<string, string | undefined> = process.env): string {
	const raw = env.PRIME_AGENT_CODING_AGENT_DIR;
	if (!raw) return join(homedir(), ".prime/agent");
	// Host-identisch (`dist/config.js` expandTildePath): nacktes `~` IST das Home, `~/…` hängt an.
	if (raw === "~") return homedir();
	return raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
}

/**
 * Das Verzeichnis, in das jede Fähigkeit ihre Quittungen schreibt.
 *
 * Ein eigener Name dafür, weil `<agentDir>/harness` eine Konvention ist und keine Ableitung —
 * sie steht in jeder Extension einzeln, und `prime-lab-spill` war die eine, in der sie fehlte.
 */
export function receiptsDir(env: Record<string, string | undefined> = process.env): string {
	return join(agentDir(env), "harness");
}
