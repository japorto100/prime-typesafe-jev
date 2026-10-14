/**
 * Vendored copy — Herkunft und Generation (nicht editieren; erst upstream ändern, dann neu vendorn).
 *
 * Quelle: `extensions/_shared/host-contract/resolver.ts` (staging-only Upstream; API, Fehlermodell
 * und Vendoring-Auflagen stehen im dortigen README).
 * Generation: resolver-v1 mit v1.1-Nachtrag, 30.09.2026 (`docs/operations/CONFIG-SCHEMA-V1.md`
 * §12), gepinnt auf die Upstream-Bytes sha256
 * `699abf4d1c8310b9d5b543dd1f8981882ff8ba2a0a174b84e2279a7a059048d2`.
 *
 * Diese Datei ist bodygleich zur Quelle; dieser Kopf ist der einzige Zusatz. Der Vergleich läuft
 * über `extensions/check-lib-drift.mjs`: der Driftkarten-Eintrag pinnt die Quelle,
 * `@vendored-from` wird vom Body-Vergleich ausgenommen und `@vendored-sha256` wird gegen die
 * vollen Upstream-Bytes geprüft — ein Upstream-Edit ohne Re-Vendoring fällt damit auf.
 *
 * Verbraucher: typesafe-bridge / JEV (Import ./agent-dir.ts; Produktion übergibt ctx.dir aus resolveAgentDir)
 *
 * @vendored-from _shared/host-contract/resolver.ts
 * @vendored-sha256 699abf4d1c8310b9d5b543dd1f8981882ff8ba2a0a174b84e2279a7a059048d2
 */
/**
 * Der Pfad-/Settings-Resolver (v1) — eine Antwort für alle Fähigkeiten.
 *
 * Contract-Freeze 25.09.2026 (`plan-archive/AGENT_DIR_PLAN.v1.md` §3.2/§3.2a); v1-Generation
 * 30.09.2026 (`docs/operations/CONFIG-SCHEMA-V1.md`, V5-Freeze). Receipts ziehen nach
 * `<agentDir>/receipts/`, Werte kommen mit der Precedenz
 * **Env > Projekt-`settings.json` > global-`settings.json` > Themendatei (Projekt > Global) > Code-Default**.
 * Prime bietet dafür keinen API-Zugang (kein `pi.getSettings()`, verifiziert), und fremde
 * Settings-Keys überleben Primes Merge — deshalb liest dieser Resolver die Dateien selbst.
 *
 * **Ein Lesepfad.** Es gibt genau EINEN Dateileser (`readStrict`): `getConfig`, die
 * Legacy-API und `loadSettings` teilen ihn. Eine vorhandene, aber kaputte/unlesbare Datei
 * bricht sichtbar ab (`ConfigResolutionError` mit Scope/origin), statt still auf eine andere
 * Schicht zu fallen — auch wenn eine höhere Schicht einen Wert trägt (V10/D07). Fehler nennen
 * Scope, Schlüsselpfad, Dateipfad und Klasse — nie Dateiinhalte, Werte oder Parsermeldungen.
 *
 * **Merge-Semantik.** Der rekursive `deepMerge` unten ist eine **bewusste Abweichung** von
 * Primes Merge (0.9.7 merged nur EINE Ebene, Dist `settings-manager.js`; RECHERCHE §3): er gilt
 * ausschließlich für unsere Selbstlese-Sicht/Tooling, nie als „Prime macht das genauso".
 * Unsere Werte werden deshalb **blattweise je Schicht** aufgelöst (kein Objekt-Merge über
 * `settings.json`) — Invarianten I1–I3 in `docs/operations/CONFIG-SCHEMA-V1.md`.
 *
 * **Alias-Regeln je Schicht.** Env-Namen werden je Schicht vor dem Merge normalisiert:
 * kanonischer Name (`schema.env`) vor deklarierten Alt-/Fehlformen (`schema.envAliases`) vor
 * der Registry bekannter Bestandsnamen (`DEFAULT_ENV_ALIASES`, u. a. die
 * `PRIME_JEV_HOOKS_ROUTER`→`PRIME_JEV_HOOK_ROUTER`-Klasse und die `PRIME_LAB_`-Altnamen der
 * compact-Familie) vor der Ableitung `PRIME_<ID>_<KEY>` und ihrer Altform
 * `PRIME_LAB_<ID>_<KEY>` — beide NUR für flache Schlüssel, weil eine Ableitung aus
 * Punkt-Schlüsseln genau die JEV-Fehlerklasse erzeugt hat. `via` trägt immer den Namen, der
 * den Wert wirklich trug.
 *
 * **Read-only.** Dieser Resolver schreibt nie. Schreibpfade sind ein eigener Apply-Weg mit
 * Backup + Receipt (Schema-Dokument §8); Security-Ausnahmen (Sandbox, Credentials, Egress,
 * Not-Aus) laufen NICHT über diese Kette.
 *
 * `dir` im `ctx` ist ein Test-Hook (Agent-Dir überschreiben); Produktion lässt ihn weg.
 * Migration ist write-new/read-old: alte Pfade bleiben über `receiptsReadPaths`/`readJsonlUnion`
 * lesbar. Dieses Upstream ist **nicht** in Pakete ausgerollt: ein realer Consumer vendort
 * bewusst genau diese Generation und erweitert die Driftkarte (`extensions/check-lib-drift.mjs`).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { agentDir } from "./agent-dir.ts";

export type Env = Record<string, string | undefined>;

export interface ResolverCtx {
	cwd?: string;
	env?: Env;
	/** Test-Hook: Agent-Dir überschreiben (Default: Primes eigener `agentDir(env)`). */
	dir?: string;
}

function envOf(ctx: ResolverCtx): Env {
	return ctx.env ?? process.env;
}

function baseOf(ctx: ResolverCtx): string {
	return ctx.dir ?? agentDir(envOf(ctx));
}

export class ConfigResolutionError extends Error {
	readonly code: "INVALID_CONFIG" | "UNREADABLE_CONFIG";
	readonly scope: string;
	/** Schlüsselpfad unter `extensionConfig.<id>`; `null` = die ganze Datei ist betroffen. */
	readonly keyPath: string | null;
	/** Wirksame Herkunft: Env-Variablenname bzw. Dateipfad; `null`, wenn unbekannt. */
	readonly origin: string | null;
	constructor(
		code: "INVALID_CONFIG" | "UNREADABLE_CONFIG",
		scope: string,
		keyPath: string | null = null,
		origin: string | null = null,
	) {
		// Never echo a JSON parser message, a file content or a value (may be a secret).
		super(`${scope}${keyPath ? `:${keyPath}` : ""}: ${code}`);
		this.code = code;
		this.scope = scope;
		this.keyPath = keyPath;
		this.origin = origin;
	}
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

interface StrictDocument {
	doc: Record<string, unknown>;
	/** sha256 der rohen Dateibytes — Provenienz für den wirksamen Wert. */
	digest: string;
}

/**
 * Der EINE Dateileser. Fehlend (ENOENT) ist `undefined`; vorhanden-aber-kaputt/unlesbar wirft
 * sanitisiert (kein Inhalt, kein Parsertext). `origin` bleibt am Fehler abfragbar.
 */
function readStrict(path: string, scope: string): StrictDocument | undefined {
	let bytes: Buffer;
	try {
		bytes = readFileSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new ConfigResolutionError("UNREADABLE_CONFIG", scope, null, path);
	}
	try {
		const parsed: unknown = JSON.parse(bytes.toString("utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return { doc: parsed as Record<string, unknown>, digest: sha256(bytes) };
		}
	} catch {
		/* sanitized below */
	}
	throw new ConfigResolutionError("INVALID_CONFIG", scope, null, path);
}

/**
 * Rekursiver Merge für unsere Tooling-Sicht — bewusste Abweichung von Primes 1-Ebenen-Merge
 * (RECHERCHE §3), NICHT als Prime-Nachbau verwenden. Objekte verschachtelt, Arrays ersetzt.
 */
export function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(over)) {
		const prev = out[key];
		if (
			prev &&
			value &&
			typeof prev === "object" &&
			typeof value === "object" &&
			!Array.isArray(prev) &&
			!Array.isArray(value)
		) {
			out[key] = deepMerge(prev as Record<string, unknown>, value as Record<string, unknown>);
		} else {
			out[key] = value;
		}
	}
	return out;
}

/** Beide Settings-Dateien, je Datei aufgelöst (Projekt übersteuert Global beim Lesen). */
export function settingsFiles(ctx: ResolverCtx = {}): { global: string; project: string | null } {
	const e = envOf(ctx);
	const global = join(baseOf(ctx), "settings.json");
	const cwd = ctx.cwd ?? e.PWD ?? process.cwd();
	return { global, project: cwd ? join(cwd, ".prime", "agent", "settings.json") : null };
}

/**
 * Global + Projekt, rekursiv gemergt (Projekt gewinnt); unbekannte Keys bleiben erhalten.
 * Streng wie `getConfig`: eine vorhandene kaputte Datei wirft. Für `extensionConfig`-Werte
 * NICHT diesen gemergten Blick lesen — dafür ist `getConfig` (Blatt-Precedenz) zuständig.
 */
export function loadSettings(ctx: ResolverCtx = {}): Record<string, unknown> {
	const { global, project } = settingsFiles(ctx);
	const projectRead = project ? readStrict(project, "project") : undefined;
	const globalRead = readStrict(global, "global");
	return deepMerge(globalRead?.doc ?? {}, projectRead?.doc ?? {});
}

function lookup(obj: Record<string, unknown>, path: string[]): unknown {
	let cur: unknown = obj;
	for (const part of path) {
		if (!cur || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[part];
	}
	return cur;
}

function envKeySegment(raw: string): string {
	return raw.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
}

/** Die Ableitung `PRIME_<ID>_<KEY>` — nur für flache Schlüssel zulässig (siehe Alias-Regeln). */
export function derivedEnvName(id: string, key: string): string {
	return `PRIME_${envKeySegment(id)}_${envKeySegment(key)}`;
}

/**
 * Die Altform derselben Ableitung — `PRIME_LAB_<ID>_<KEY>` (Vor-Rename-Stand, M2(c)-Rest/§11.5:
 * z. B. `PRIME_LAB_COMPACT_SOFT_AT`). Gilt wie die Ableitung NUR für flache Schlüssel und rankt
 * hinter dem kanonischen Namen; nicht-mechanische Altnamen stehen in `DEFAULT_ENV_ALIASES`.
 */
export function legacyDerivedEnvName(id: string, key: string): string {
	return `PRIME_LAB_${envKeySegment(id)}_${envKeySegment(key)}`;
}

/**
 * Registry bekannter Bestands-/Fehlformen je Familie, Prioritätsordnung: kanonischer
 * (dokumentierter) Name zuerst, danach die beobachtete Fehlform. Beispiel-Klassen:
 * `PRIME_JEV_HOOKS_ROUTER` (Ableitung aus `hooks.router`) → `PRIME_JEV_HOOK_ROUTER`
 * (dokumentiert); `PRIME_LAB_*`-Altnamen der compact-Familie. Consumer dürfen das über
 * `schema.env`/`schema.envAliases` erweitern.
 */
export const DEFAULT_ENV_ALIASES: Record<string, Record<string, readonly string[]>> = Object.freeze({
	jev: Object.freeze({
		"hooks.router": Object.freeze(["PRIME_JEV_HOOK_ROUTER", "PRIME_JEV_HOOKS_ROUTER"]),
		"thresholds.min_p": Object.freeze(["PRIME_JEV_ROUTER_MIN_P", "PRIME_JEV_THRESHOLDS_MIN_P"]),
		"thresholds.min_needs": Object.freeze(["PRIME_JEV_ROUTER_MIN_NEEDS", "PRIME_JEV_THRESHOLDS_MIN_NEEDS"]),
	}),
	// compact: Die generische `PRIME_LAB_`-Klasse deckt `PRIME_LAB_COMPACT_*` ab. Hier stehen nur
	// die Bestandsnamen, die sie NICHT erzeugt (Spill/Capsule ohne `COMPACT`-Segment,
	// `PRIME_LAB_HARNESS_*`) — kanonischer Name zuerst, er gewinnt innerhalb der Schicht.
	// Spiegel von `extensions/compact/compact-config.ts` LEGACY_ENV_ALIASES (dortige Quelle).
	compact: Object.freeze({
		verify: Object.freeze(["PRIME_COMPACT_VERIFY", "PRIME_LAB_HARNESS_COMPACT_VERIFY"]),
		spill_max_bytes: Object.freeze(["PRIME_COMPACT_SPILL_MAX_BYTES", "PRIME_LAB_SPILL_MAX_BYTES"]),
		spill_preview_bytes: Object.freeze(["PRIME_COMPACT_SPILL_PREVIEW_BYTES", "PRIME_LAB_SPILL_PREVIEW_BYTES"]),
		spill_max_files: Object.freeze(["PRIME_COMPACT_SPILL_MAX_FILES", "PRIME_LAB_SPILL_MAX_FILES"]),
		spill_dir: Object.freeze(["PRIME_COMPACT_SPILL_DIR", "PRIME_LAB_SPILL_DIR"]),
		spill_reinject: Object.freeze(["PRIME_COMPACT_SPILL_REINJECT", "PRIME_LAB_SPILL_REINJECT"]),
		spill_exempt_tools: Object.freeze(["PRIME_COMPACT_SPILL_EXEMPT_TOOLS", "PRIME_LAB_SPILL_EXEMPT_TOOLS"]),
		spill_receipts: Object.freeze(["PRIME_COMPACT_SPILL_RECEIPTS", "PRIME_LAB_SPILL_RECEIPTS"]),
		capsule: Object.freeze(["PRIME_COMPACT_CAPSULE", "PRIME_LAB_CAPSULE", "PRIME_LAB_HARNESS_CAPSULE"]),
		capsule_arm: Object.freeze(["PRIME_COMPACT_CAPSULE_ARM", "PRIME_LAB_CAPSULE_ARM", "PRIME_LAB_HARNESS_CAPSULE_ARM"]),
		capsule_max_age_ms: Object.freeze(["PRIME_COMPACT_CAPSULE_MAX_AGE_MS", "PRIME_LAB_CAPSULE_MAX_AGE_MS"]),
		capsule_receipts: Object.freeze(["PRIME_COMPACT_CAPSULE_RECEIPTS", "PRIME_LAB_CAPSULE_RECEIPTS"]),
	}),
});

/**
 * Env-Namen für (id, key) in Prioritätsordnung. Innerhalb der Env-Schicht gewinnt der erste
 * gesetzte Name; leere/Whitespace-Werte zählen wie „nicht gesetzt". Punkt-Schlüssel bekommen
 * NUR deklarierte Namen (keine Ableitung — genau die vermiedene Fehlerklasse), für flache
 * Schlüssel folgt der kanonischen Ableitung die `PRIME_LAB_`-Altform.
 */
export function envNamesFor(id: string, key: string, schema?: ConfigSchema): string[] {
	const names: string[] = [];
	const push = (name: string | undefined | null): void => {
		if (name && !names.includes(name)) names.push(name);
	};
	push(schema?.env?.[key]);
	for (const name of schema?.envAliases?.[key] ?? []) push(name);
	for (const name of DEFAULT_ENV_ALIASES[id]?.[key] ?? []) push(name);
	if (!key.includes(".")) {
		push(derivedEnvName(id, key));
		push(legacyDerivedEnvName(id, key));
	}
	return names;
}

/** Zulässige Werttypen des V1-Schemas (Freeze: `docs/operations/CONFIG-SCHEMA-V1.md` §2). */
export type ConfigKind = "bool" | "enum" | "number" | "string" | "path";

/**
 * Schema je Familie. Alle Felder sind optional; ohne `kind` gilt „skalarer Rohwert"
 * (string/number/boolean — Objekte/Arrays/null sind ungültig).
 */
export interface ConfigSchema {
	/** Werttyp je Schlüssel. */
	kind?: Record<string, ConfigKind>;
	/** Erlaubte Werte für `kind: "enum"` (Strings); fehlt die Liste, gilt freier String. */
	values?: Record<string, readonly string[]>;
	/** Untere/obere Grenze für `kind: "number"`. */
	min?: Record<string, number>;
	max?: Record<string, number>;
	/** Kanonischer (dokumentierter) Env-Name je Schlüssel. */
	env?: Record<string, string>;
	/** Weitere Env-Namen (Alt-/Fehlformen), nach `env`, vor der Ableitung. */
	envAliases?: Record<string, readonly string[]>;
	/** Adresse des Werts in einer Themendatei (Default: der Schlüssel selbst). */
	fileKeys?: Record<string, string>;
}

/** Herkunft des Werts für die Parse-Entscheidung (z. B. Pfadklassen-Prüfung). */
export interface ConfigParseContext {
	layer: "env" | "project" | "global" | "file";
	fileScope?: "project" | "global";
	origin: string;
}

export type ConfigParser<T> = (value: unknown, context: ConfigParseContext) => T;

export const configParsers = {
	boolean(value: unknown): boolean {
		if (typeof value === "boolean") return value;
		if (typeof value === "string") {
			if (["on", "true", "1"].includes(value.toLowerCase())) return true;
			if (["off", "false", "0"].includes(value.toLowerCase())) return false;
		}
		throw new Error("invalid boolean");
	},
	integer(min: number, max: number): ConfigParser<number> {
		return (value) => {
			const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
			if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min || n > max) throw new Error("invalid integer");
			return n;
		};
	},
	strings(value: unknown): string[] {
		if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim()))
			throw new Error("invalid strings");
		return value;
	},
};

function assertScalar(value: unknown): unknown {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	throw new Error("invalid scalar");
}

/**
 * Projekt-scope-Pfade (Projekt-Settings oder Projekt-Themendatei) bleiben im cwd: relativ
 * erlaubt, absolut nur innerhalb, `~` verboten (M7). Env/Global bleiben frei (Owner-Scope).
 */
function projectSafePath(value: unknown, context: ConfigParseContext, ctx: ResolverCtx): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error("invalid path");
	const projectScoped = context.layer === "project" || (context.layer === "file" && context.fileScope === "project");
	if (!projectScoped) return value;
	const cwd = ctx.cwd ?? envOf(ctx).PWD;
	if (!cwd) throw new Error("path scope without cwd");
	if (value === "~" || value.startsWith("~/")) throw new Error("project path may not use home");
	const root = resolvePath(cwd);
	const resolved = resolvePath(root, value);
	const rest = relative(root, resolved);
	if (rest === "" || (!rest.startsWith("..") && !isAbsolute(rest))) return value;
	throw new Error("project path escapes cwd");
}

function schemaParser(schema: ConfigSchema | undefined, key: string, ctx: ResolverCtx): ConfigParser<unknown> {
	const kind = schema?.kind?.[key];
	const values = schema?.values?.[key];
	const min = schema?.min?.[key];
	const max = schema?.max?.[key];
	return (value, context) => {
		switch (kind) {
			case "bool":
				return configParsers.boolean(value);
			case "number": {
				const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
				if (typeof n !== "number" || !Number.isFinite(n)) throw new Error("invalid number");
				if (typeof min === "number" && n < min) throw new Error("number below minimum");
				if (typeof max === "number" && n > max) throw new Error("number above maximum");
				return n;
			}
			case "string": {
				if (typeof value !== "string") throw new Error("invalid string");
				return value;
			}
			case "enum": {
				if (typeof value !== "string") throw new Error("invalid enum");
				if (values && !values.includes(value)) throw new Error("enum value not allowed");
				return value;
			}
			case "path":
				return projectSafePath(value, context, ctx);
			default:
				return assertScalar(value);
		}
	};
}

/** Herkunft eines wirksamen Werts — Schicht, Name/Pfad und tatsächlich tragender Name. */
export interface ConfigProvenance {
	layer: "env" | "project" | "global" | "file" | "unset";
	/** Env-Variablenname bzw. Dateipfad; `null` bei unset. */
	origin: string | null;
	/** Name, unter dem die Schicht den Wert trug: Env-Alias, Dateikey oder Schlüsselname. */
	via: string;
	/** Nur `layer: "file"`: welche der beiden Themendateien (Projekt vor Global). */
	fileScope?: "project" | "global";
	/** sha256 der rohen Dateibytes der wirksamen Schicht; `null` bei env und unset. */
	digest: string | null;
}

export interface ResolvedConfig<T = unknown> extends ConfigProvenance {
	value: T;
	/** `false` = keine Schicht trug einen Wert (Code-Default des Consumers greift). */
	set: boolean;
}

export interface GetConfigOptions<T = unknown> {
	schema?: ConfigSchema;
	/** Bequemlichkeits-Rückfall bei `set: false`; wird NICHT als eigene Schicht geführt. */
	fallback?: T;
	ctx?: ResolverCtx;
	/** Themendatei-Name (z. B. `"prime-compact.json"`), Projekt- und Global-Ort. */
	file?: string;
	/** Explizite Adresse in der Themendatei; Default `schema.fileKeys[key] ?? key`. */
	fileKey?: string;
}

/**
 * Harte Key-Form des V1-Schemas: flache Segmente aus `[A-Za-z0-9_]`, Punkte NUR als
 * Literal-Trenner (kein Objekt-Pfad, kein Slash/Leerzeichen/leeres Segment). Die Konvention
 * `lower_snake_case` für NEUE Schlüssel prüft der Katalog (Schema-Doc §2); die harte Prüfung
 * lässt Bestandsformen wie `fileKey` bewusst passieren (Bestandstest resolver.test.mjs).
 */
const EXTENSION_ID_FORM = /^[a-z0-9_]+$/;
const CONFIG_KEY_FORM = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;

/** API-/Formfehler sind Programmierfehler (TypeError), keine Config-Fehler. */
function assertKeyForm(id: string, key: string): void {
	if (!EXTENSION_ID_FORM.test(id)) throw new TypeError("invalid extension id");
	if (!CONFIG_KEY_FORM.test(key)) throw new TypeError("invalid config key");
}

interface Candidate {
	layer: "env" | "project" | "global" | "file";
	fileScope?: "project" | "global";
	origin: string;
	via: string;
	digest: string | null;
	value: unknown;
}

interface ResolveCoreOptions {
	envNames: readonly string[];
	fileKey?: string;
	file?: string;
	parse: ConfigParser<unknown>;
}

/**
 * Der Kern: alle Schichten lesen (kaputte Datei wirft SOFORT, auch wenn eine höhere Schicht
 * trägt), dann die erste Schicht mit gesetztem Wert parsen. Nur der wirksame Wert wird
 * ge-parst; übersteuerte Werte bleiben ungeprüft (Shadowing, keine stille Wert-Korrektur).
 */
function resolveCore(
	id: string,
	key: string,
	ctx: ResolverCtx,
	opts: ResolveCoreOptions,
): { value: unknown; set: boolean; provenance: ConfigProvenance } {
	assertKeyForm(id, key);
	const e = envOf(ctx);
	const candidates: Candidate[] = [];
	for (const name of opts.envNames) {
		const value = e[name];
		// Leere/Whitespace-Env zählt wie „nicht gesetzt" (Compact-Präzedenz; `VAR=` ist kein Wert).
		if (value !== undefined && !(typeof value === "string" && value.trim() === "")) {
			candidates.push({ layer: "env", origin: name, via: name, digest: null, value });
			break;
		}
	}
	const { global, project } = settingsFiles(ctx);
	if (project) {
		const read = readStrict(project, "project");
		if (read)
			candidates.push({
				layer: "project",
				origin: project,
				via: key,
				digest: read.digest,
				value: lookup(read.doc, ["extensionConfig", id, key]),
			});
	}
	const globalRead = readStrict(global, "global");
	if (globalRead)
		candidates.push({
			layer: "global",
			origin: global,
			via: key,
			digest: globalRead.digest,
			value: lookup(globalRead.doc, ["extensionConfig", id, key]),
		});
	if (opts.file) {
		const fileKey = opts.fileKey ?? key;
		if (project) {
			const path = join(dirname(project), opts.file);
			const read = readStrict(path, "file");
			if (read)
				candidates.push({
					layer: "file",
					fileScope: "project",
					origin: path,
					via: fileKey,
					digest: read.digest,
					value: lookup(read.doc, [fileKey]),
				});
		}
		const path = join(baseOf(ctx), opts.file);
		const read = readStrict(path, "file");
		if (read)
			candidates.push({
				layer: "file",
				fileScope: "global",
				origin: path,
				via: fileKey,
				digest: read.digest,
				value: lookup(read.doc, [fileKey]),
			});
	}
	for (const candidate of candidates) {
		if (candidate.value === undefined) continue;
		let parsed: unknown;
		try {
			parsed = opts.parse(candidate.value, {
				layer: candidate.layer,
				...(candidate.fileScope ? { fileScope: candidate.fileScope } : {}),
				origin: candidate.origin,
			});
		} catch {
			throw new ConfigResolutionError("INVALID_CONFIG", candidate.layer, key, candidate.origin);
		}
		return {
			value: parsed,
			set: true,
			provenance: {
				layer: candidate.layer,
				origin: candidate.origin,
				via: candidate.via,
				...(candidate.fileScope ? { fileScope: candidate.fileScope } : {}),
				digest: candidate.digest,
			},
		};
	}
	return { value: undefined, set: false, provenance: { layer: "unset", origin: null, via: key, digest: null } };
}

/**
 * V1-API: ein Wert aus `extensionConfig.<id>.<key>`, blattweise über alle Schichten, mit
 * vollständiger Provenienz. Wirft `ConfigResolutionError` bei kaputter vorhandener Datei und
 * bei ungültigem wirksamem Wert. `key` ist ein LITERALER Schlüssel; Punkte sind nur Teil des
 * Key-Strings, kein Pfad in Objekte.
 */
export function getConfig<T = unknown>(id: string, key: string, opts: GetConfigOptions<T> = {}): ResolvedConfig<T> {
	const ctx = opts.ctx ?? {};
	const parse = schemaParser(opts.schema, key, ctx);
	const result = resolveCore(id, key, ctx, {
		envNames: envNamesFor(id, key, opts.schema),
		fileKey: opts.fileKey ?? opts.schema?.fileKeys?.[key],
		file: opts.file,
		parse,
	});
	if (!result.set) return { ...result.provenance, value: opts.fallback as T, set: false };
	return { ...result.provenance, value: result.value as T, set: true };
}

export interface ConfigOptions {
	/** Expliziter Env-Name; Default: `envNamesFor(id, key, schema)`. */
	envName?: string;
	/** Themendatei (z. B. `compact.json`) als unterste Dateischicht; Adresse via `fileKey`/Schema. */
	file?: string;
	fileKey?: string;
	schema?: ConfigSchema;
}

/** Auflösung der Legacy-API mit nachvollziehbarer Herkunft: `origin`/`digest` der wirksamen Schicht. */
export interface ConfigResolution<T> {
	value: T;
	source: "env" | "project" | "global" | "file" | "default";
	/** Env-Variablenname bzw. Dateipfad der wirksamen Schicht; `null` beim Default. */
	origin: string | null;
	/** sha256 der rohen Dateibytes der wirksamen Schicht; `null` bei Env und Default. */
	digest: string | null;
}

/**
 * Legacy-API (`configValue`-Rückgrat): gleiche Precedenz über denselben Kern, Rückgabeform des
 * 25.09.-Contracts. Neue Consumer nutzen `getConfig` (Provenienz `layer/origin/via`).
 */
export function resolveTypedConfig<T>(
	id: string,
	key: string,
	fallback: T,
	parse: ConfigParser<T>,
	ctx: ResolverCtx = {},
	opts: ConfigOptions = {},
): ConfigResolution<T> {
	const result = resolveCore(id, key, ctx, {
		envNames: opts.envName ? [opts.envName] : envNamesFor(id, key, opts.schema),
		fileKey: opts.fileKey ?? opts.schema?.fileKeys?.[key],
		file: opts.file,
		parse: parse as ConfigParser<unknown>,
	});
	if (!result.set) return { value: fallback, source: "default", origin: null, digest: null };
	const layer = result.provenance.layer;
	if (layer === "unset") return { value: fallback, source: "default", origin: null, digest: null };
	return {
		value: result.value as T,
		source: layer,
		origin: result.provenance.origin,
		digest: result.provenance.digest,
	};
}

/**
 * Bequemer Wert-Lookup mit der Contract-Precedenz: Env > Projekt-Settings > Global-Settings >
 * Themendatei > Default. `key` ist der Literal-Schlüssel unter `extensionConfig.<id>`.
 */
export function configValue<T>(
	id: string,
	key: string,
	fallback: T,
	ctx: ResolverCtx = {},
	opts: ConfigOptions = {},
): T {
	// Compatibility signature, but no generic type assertion: a boolean `off` must never
	// masquerade as a truthy boolean. Complex values need an explicit parser via resolveTypedConfig.
	const parse: ConfigParser<T> = (value) => {
		if (typeof fallback === "boolean") return configParsers.boolean(value) as T;
		if (typeof fallback === "number") {
			const n = typeof value === "string" && value.trim() ? Number(value) : value;
			if (typeof n === "number" && Number.isFinite(n)) return n as T;
		} else if (typeof fallback === "string" && typeof value === "string") return value as T;
		throw new Error("explicit parser required");
	};
	return resolveTypedConfig(id, key, fallback, parse, ctx, opts).value;
}

/** `<agentDir>/receipts/` — das neue Zuhause aller Quittungen/Logs. */
export function receiptsDir(ctx: ResolverCtx = {}): string {
	return join(baseOf(ctx), "receipts");
}

export interface ReceiptsName {
	/** z. B. `receipts` → `<topic>.receipts.jsonl`, `calls` → `<topic>.calls.jsonl`. */
	suffix?: string;
	envName?: string;
}

/** Neuer Dateipfad; Env-Override (Default `PRIME_<TOPIC>_RECEIPTS`) gewinnt. */
export function receiptsFile(topic: string, ctx: ResolverCtx = {}, opts: ReceiptsName = {}): string {
	const e = envOf(ctx);
	const override = e[opts.envName ?? derivedEnvName(topic, "receipts")];
	if (override && override.trim()) return override;
	const name = opts.suffix ? `${topic}.${opts.suffix}.jsonl` : `${topic}.jsonl`;
	return join(receiptsDir(ctx), name);
}

/**
 * Alte Pfade je Thema (write-new/read-old). Reihenfolge = Historie: alt → neu.
 * Nur existierende Alte werden geliefert, der neue Pfad steht immer am Ende.
 */
export const LEGACY_RECEIPTS: Record<string, string[]> = {
	harness: ["harness/prime-lab-harness.receipts.jsonl"],
	roles: ["harness/prime-roles.receipts.jsonl", "harness/prime-lab-roles.receipts.jsonl"],
	evidence: ["harness/prime-lab-evidence.jsonl"],
	facts: ["harness/prime-lab-facts.receipts.jsonl"],
	workflow: ["harness/workflow.receipts.jsonl"],
	reader: ["harness/activation-log.jsonl"],
	jev: ["harness/jev-calls.jsonl"],
	spill: ["harness/prime-lab-spill.receipts.jsonl"],
	verify: ["harness/prime-lab-compact-verify.receipts.jsonl"],
	capsule: ["harness/prime-lab-capsule.receipts.jsonl"],
};

export function receiptsReadPaths(topic: string, ctx: ResolverCtx = {}, opts: ReceiptsName = {}): string[] {
	const legacy = (LEGACY_RECEIPTS[topic] ?? []).map((rel) => join(baseOf(ctx), rel)).filter((path) => existsSync(path));
	return [...legacy, receiptsFile(topic, ctx, opts)];
}

/**
 * Klassen-gerechte Leseunion (Contract §3.4): alte Dateien zuerst, dann die neue; optional
 * dedupliziert per exakter Zeile. Kein Digest-Vergleich — der misst die falsche Invariante.
 */
export function readJsonlUnion(paths: string[], opts: { dedupe?: boolean } = {}): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const path of paths) {
		if (!existsSync(path)) continue;
		for (const raw of readFileSync(path, "utf8").split("\n")) {
			const line = raw.trim();
			if (!line) continue;
			if (opts.dedupe) {
				if (seen.has(line)) continue;
				seen.add(line);
			}
			out.push(line);
		}
	}
	return out;
}
