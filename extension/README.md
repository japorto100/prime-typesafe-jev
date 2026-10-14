# prime-lab-typesafe-bridge — JEV-Bridge (prime-lab Extension)

Host-Extension für Prime: kapselt **TypeSafe JEV** (System-1-Entscheidungen, `api.typesafe.ai/v1/systemone`)
hinter einem privaten Unix-Socket (`PRIME_JEV_SOCKET`) und stellt gleichzeitig den **deterministischen
Sicherheits-Floor** für Tool-Aufrufe. Der Python-Skill `typesafe-jev` spricht **nur** über den Socket;
Credentials bleiben im Host-Prozess.

```
Python-Kernel (Skill typesafe-jev)          Node-Host (diese Extension)                 Upstream
system_one_async(state, questions)          privater UDS (mkdtemp, 0700/0600)           HTTPS POST
  └─ PRIME_JEV_SOCKET ────────────────────▶ Provider-Seam (core/provider.ts) ─────────▶ api.typesafe.ai
     ◀──── answers/probabilities ───────────  Validator + Receipts + Eval-Kanal          (model: jev-latest)
```

## Was drin ist

| Pfad | Rolle |
|---|---|
| `index.ts` | Wiring: Hooks registrieren, ein Dispatch-Pfad (`Budget → Provider → Validator → Receipt v2 → Eval`) |
| `transport.ts` | Privater Socket (mkdtemp 0700, Socket 0600), Host-Singleton über Reloads (Variante A), `retire()` nur bei `quit`, Liveness-Sweep |
| `coding-policy.ts` | Idempotenter System-Prompt-Append `[prime-jev-coding-policy-v1]` |
| `input-triage.ts` | Opt-in Input-Klassifikation (nur `PRIME_JEV_INPUT_TRIAGE=advisory`), advisory UI-Hinweise |
| `confirmation.ts` | Bounded HITL-Confirm (Fehler/Timeout/ungültige Antwort ⇒ deny) |
| `distribution.ts` + `core/validator.ts` | Rundungsintervall-/Argmax-Ties-Prüfung (`choiceFits`) + gemeinsame Antwortprüfung (Batch **und** Legacy-Adapter) |
| `receipts.ts` | Receipts `prime-jev/call/2` (additiver Superset; `normalizeReceipt()` für v1/v2) |
| `upstream-response.ts` | Größen-/Parser-Grenzen für Upstream-Antworten (1 MiB, keine Byte-Reflexion) |
| `core/provider.ts` | **Seam**: genau ein Provider `jev` (Capability-Matrix, Deadline-Konstante 1200 ms); fremde Provider später über `PRIME_JEV_PROVIDER` |
| `core/eval-channel.ts` | Getrennter Messkanal `prime-jev/eval/1` (nur Messmodus, nur Zahlen/Enums) |
| `core/budget.ts` | Persistentes Tagesbudget + Root-Deckel, Kill-Switch `PRIME_JEV_BUDGET_KILL` |
| `core/redactor.ts` | Technische Egress-Redaktion (`redact` Default, `block` opt-in, `off` explizit) |
| `core/floor.ts` | Deterministischer Tool-Floor zweistufig (`block` / `warn`), Tripwire — **keine** Security-Boundary |
| `hooks/` | A2 `router`, A4 `tool-gate`, A5 `watchdog`, A6 `result-triage`, A3 `compaction` (shadow-only), A8 `refine-advisor` (shadow-only); Leiter + G1 in `hooks/modes.ts` |
| `eval/` | Label-Harness `router-eval.mjs` + `router-tasks.json` (kuratierte hit@1-Messung, headless) |
| `tests/` | `node --test`-Suiten (Probes, Lifecycle, Redactor, Floor-Korpus, Router, Gate, Watchdog/Triage, Compaction, Refine) + Digest-Gates |

## Rollout-Leiter je Hook

`off → G1(je Hook × Datenklasse) → shadow → advisory → live`. **Shadow sendet bereits** (deshalb ist G1
Vorbedingung): alle Hooks sind default `off`; ein Modus ohne G1 bleibt stumm.

| Env-Var | Bedeutung |
|---|---|
| `PRIME_JEV_HOOK_{ROUTER,TOOL_GATE,WATCHDOG,RESULT_TRIAGE,COMPACTION,REFINE}` | Modus: `shadow` \| `advisory` \| `live` (Default `off`) |
| `PRIME_JEV_G1` | Freigaben kommagetrennt, z. B. `router:prompt,router:skill-metadata,tool-gate:tool-input,watchdog:turn-facts,result-triage:tool-result,compaction:conversation-blocks,refine:metrics` |
| `PRIME_JEV_EVAL` / `PRIME_JEV_EVAL_FILE` | Messkanal an + Zieldatei (Default `~/.prime/agent/receipts/jev.eval.jsonl`) |
| `PRIME_JEV_ROUTER_MIN_P` | Advisory-Schwelle für Skill-Hinweise — **kein Default**, ohne Wert bleibt advisory = shadow |
| `PRIME_JEV_TOOLGATE_CONFIRM_ON` | Prädikate (kommagetrennt), die live HITL auslösen, z. B. `irreversible,accesses_credentials` |
| `PRIME_JEV_WATCHDOG_EVERY` | Kadenz der Watchdog-Läufe (Default 3 Turns; Fehler triggern immer) |
| `PRIME_JEV_TRIAGE_MAX_PENDING` / `_MAX_BYTES` / `_MAX_WAIT_MS` | Lastvertrag der Result-Triage-Queue (Default 32 / 8 MiB / 60 s) |
| `PRIME_JEV_EGRESS` | `redact` (Default) \| `block` \| `off` |
| `PRIME_JEV_AGENT_DIR` | Isolierter Agent-Root für Auth/Receipts/Budget (Tests/Profile) |
| `PRIME_JEV_BUDGET_KILL=1` | Not-Aus für alle JEV-Aufrufe |

### Settings-Heimat (Consumer-Migration 30.09.2026)

Modi und Advisory-Schwellen kommen zusätzlich aus `extensionConfig.jev` (flache Literal-Keys):
`"hooks.router"`/`"hooks.tool_gate"`/`"hooks.watchdog"`/`"hooks.result_triage"`/`"hooks.compaction"`/
`"hooks.refine"` (`off|shadow|advisory|live`) und `"thresholds.min_p"`/`"thresholds.min_needs"` (0…1).
Precedenz je Schlüssel: Env (kanonisch zuerst, dann `PRIME_LAB_JEV_*`-Altnamen, dann die bekannte
Fehlform `PRIME_JEV_HOOKS_ROUTER`/`PRIME_JEV_THRESHOLDS_MIN_*`) > Projekt-settings > Global-settings
> Code-Default `off`; eine vorhandene kaputte `settings.json` bricht sichtbar ab (V10,
`ConfigResolutionError`) statt still „off". `PRIME_JEV_G1`, `PRIME_JEV_BUDGET_KILL`, `PRIME_JEV_EGRESS`
und `PRIME_JEV_AGENT_DIR` bleiben bewusst Env-only (Sicherheits-/Not-Aus-Kanäle, CONFIG-SCHEMA §10).
Der (vendorte) Resolver `_shared/host-contract/resolver.ts` liest den Host-Agent-Dir wie alle
Consumer; `PRIME_JEV_AGENT_DIR` isoliert weiter Auth/Receipts/Budget. Beleg: `tests/jev_settings.test.mjs`.

Invarianten: **JEV blockt nie** (nur Floor + HITL); Floor-Fehler fail-closed mit eigenem Pfad; Compaction/Refine
liefern **immer `undefined`**; Receipts/Eval sind **content-free** (keine Prompts/Antworten/Tool-Payloads).

### Session- und Lastvertrag (Audit D05/D14, 27.09.2026)

- **Pro Sitzung:** Dedup, Beweis-Historie (`recent_evidence_signatures`) und Run-Bindung
  (`hooks/run-context.ts`) sind pro stabiler Session-ID geführt. Identischer Output in B ist neue
  Evidenz in B; ein Sessionwechsel invalidiert nur die eigene Generation — A-Shutdown/-Reload lässt
  Bs Queue unberührt, und ein Guard prüft vor jedem Send erneut. Ein fertiger Job hält die zur
  Eventzeit beobachtete Session (kein erneutes Lesen eines später gedrifteten `ctx`-Getters);
  Host-Abbrüche (`event.signal` von `session_before_compact`/`session_before_refine`) binden in
  denselben Guard (C030).
- **Queue-Lastvertrag:** Die asynchrone Runner-Queue ist durch `maxPending`, `maxRetainedBytes`,
  Deadline und Per-Session-Coalescing begrenzt (neuester Payload gewinnt). Jede Ablehnung wird als
  `dropped`/`coalesced`/`expired`/`gated` gezählt, ist über `handler.stats()` abfragbar und reitet
  als `queue`-Objekt im Receipt der Result-Triage — kein stilles Verwerfen.

## Datenprodukte

- **Receipts** `~/.prime/agent/receipts/jev.calls.jsonl`, Schema **`prime-jev/call/2`** (additiver Superset von v1):
  `hook/mode/origin/outcome/questions_version/provider/bytes_in|out/would/redactions/…`, ohne Inhalte.
  Union-Reader: `normalizeReceipt()`; v1-Baseline archiviert (`archive/2026-09-24-jev-calls-baseline/`).
- **Eval-Kanal** `prime-jev/eval/1` (nur mit `PRIME_JEV_EVAL=1`): typisierte Vorhersagen (`noul`/probabilities),
  Kandidatenliste, Modell-/Regelversion, `skip_reason` für skippte Situationen (Denominator).
- **Budget** `~/.prime/agent/receipts/jev.budget.json` (Tageszähler, überlebt Neustarts).

## Gates & Tests

```bash
npm run typecheck   # tsc
npm test            # node --test: Proben, Router, Gate, Watchdog/Triage, Compaction, Refine, Digest
npm run smoke       # jiti-Load unter Live-Bedingungen (wie Prime)
npm run digest      # Staging-Manifest prüfen; digest:update bewusst neu erzeugen
uv run --offline --no-project --with pytest pytest skills/typesafe-jev/tests -q   # Client + Recipes
```

Stand 24.09.2026: tsc · `node --test` 86/86 · Biome 0 errors · Smoke OK · pytest 14.
Stand 30.09.2026 (Consumer-Migration): tsc · `node --test` 164/164 (inkl. `tests/jev_settings.test.mjs`)
· jiti-Smoke OK · Staging-Digest bewusst neu erzeugt (`npm run digest:update`).

## Blueprint / Referenzen (nur Muster, kein Vendoring)

- `@mohan-cao/pi-jev-response-router` (Apache-2.0) — <https://pi.dev/packages/@mohan-cao/pi-jev-response-router>
- `pi-jev-guard` (Lizenz unklar, nur Muster) — <https://pi.dev/packages/pi-jev-guard>

Plan/Evidenz: `plan-archive/JEV-ENHANCEMENT-PLAN.md` (ausgeführt/archiviert) und `JEV_PLAN_LIVE_OPEN.md`
(Live-Betrieb + offene Punkte J1–J6), Messberichte in `archive/2026-09-24-{router,toolgate,hooks}-shadow/`.
Deploy: Copy-only `promote/promote.mjs --apply` (Backup + Digest-Receipt, `--only`-Filter);
Pre-Promote-Live-Stand archiviert unter `archive/2026-09-24-live-pre-promote/`.
