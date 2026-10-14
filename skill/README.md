# typesafe-jev — Python-Skill für TypeSafe JEV

Der Kernel-Teil der JEV-Integration: eine schmale Python-API für **System-1-Entscheidungen**
(`choice` / `score` / `noul`) über den Host-Socket `PRIME_JEV_SOCKET`. Der Socket gehört der
Extension `typesafe-bridge`; **Credentials sieht dieser Skill nie** — er kann nur über den Host sprechen.

## API

```python
from typesafe_jev import system_one_async, result

assessment = await system_one_async(
    {"requirement": ..., "candidate": ..., "observations": ...},   # state (bounded, redigiert)
    {
        "coverage":   {"type": "noul",  "instructions": "Do the observations exercise the requirement?"},
        "next_step":  {"type": "choice", "instructions": "Which next step is supported?",
                       "criteria": {"inspect": "...", "test": "...", "unknown": "..."}},
        "impact":     {"type": "score",  "instructions": "How broad is the impact?",
                       "criteria": ["local", "several callers", "multiple contracts"]},
    },
)
answers = assessment["answers"]        # vollständige Distributions-/Legend-/Model-/Usage-Daten
```

| Funktion | Rolle |
|---|---|
| `system_one` / `system_one_async` | **Bevorzugt.** Nativer Batch; `_async` blockiert den Event-Loop nicht |
| `choice(context, choices, …)` | Legacy-Skalar (sync; `await` ist nur Zucker — macht den I/O nicht async) |
| `score(context, criterion/rubric, …)` | Legacy-Skalar, geordnete Rubrik **2–10 Level** |
| `noul(context, condition, …)` | Ja/Nein-Urteil über **eine eng formulierte, prüfbare Aussage** (Frageform zulässig) |
| `decide(method, **params)` / `run(method, …)` | generisch / Prime-`run()`-Konvention |
| `result(value)` | expliziter Container: `{status: answered\|fallback, value, provenance}` |

## Semantik & Fehlergrenzen

- Jede Antwort ist eine **Verteilung**, keine Wahrheit; `confidence`/`probabilities` sind Modellausgaben,
  **kein Beweis und keine formale Verifikation**; kein universaler Schwellwert.
- **Ungebundene Bridge = Fehler** (`JevBridgeError`), **Mock-Antworten werden verworfen** — kein synthetischer Erfolg.
- `unavailable` ist **kein Wertzustand**: fehlende Bridge, Transportfehler, RPC-Ablehnungen
  (`JevRPCError: JevUnavailable|JevBudgetExceeded|JevProviderUnsupported|…`) und Mock-Antworten werfen.
  Sie dürfen nie zu `False`, `unknown` oder einem stillen Fallback werden; `result()` kennt deshalb nur
  `answered|fallback`. Ein Modell-`noul=False`/`choice="unknown"` ist eine negative Klassifikation.
- Explizite Legacy-Fallbacks (`fallback=…`) sind **markiert** (`Fallback*`, `is_fallback=True`) und nur über
  `result()` verwechslungssicher; `await` auf Legacy-Skalaren ist dokumentierte Charakteristik (sync).
- `noul`: entscheidend ist die Eindeutigkeit des Sachverhalts; Unknown/diffuse Verteilungen sind unaufgelöste
  Evidenz — keine Erlaubnis, Produktverhalten zu erfinden.
- Nur autorisierter, **lokal redigierter** Kontext darf in den `state` (Host-Redactor läuft zusätzlich;
  Remote-Secret-Detection ist nie die erste Schutzschicht). Der Host besitzt Egress-Modus und Tagesbudget;
  der Kernel sieht weder Session- noch Restbudget und kann beides nicht umgehen (direkte Kernel-Calls sind
  `explicit_python`, keine Auto-Hooks, aber budgetiert).
- **Wire-Grenzen:** Request ≤ 64 KiB inklusive Newline-Frame (Host-Cap aus `transport.ts`), Antwort ≤ 1 MiB,
  Socket-Timeout 2 s; Fehlerantworten übertragen nur einen sanitisierten Code, keine Rohinhalte.

## Rezepte (`coding_questions.py`)

Optionale, explizite Frage-Builder — keine Hooks, keine Automatik:

- `coding_questions(requirements)` — Diagnose/Impact/Evidenz + pro Requirement ein `noul`
- `verifier_questions()` — unabhängige Verifikation + Restrisiko-Kategorie
- `next_test_questions(candidates)` — welcher Testlauf diskriminiert die Hypothese (+ Residual `none`)
- `role_selection_questions(roles)` — Rollen-Compose aus **tatsächlich verfügbaren** Beschreibungen
- `source_selection_questions(sources, max_sources=8)` — Relevanz je Quelle (gebunden, vor-gefiltert)

## Betrieb

- Importname `typesafe_jev`; Socket-Pfad wird **pro Call** aus `os.environ` gelesen (Variant A, reload-fest).
  Die blosse Installation des Skills startet weder Dienst noch Hooks — die Host-Extension muss geladen sein.
- Tests: `uv run --offline --no-project --with pytest pytest tests -q` (Probes, Recipes und
  Socket-Vertragstest gegen einen Fake-Host). Offline-Build: `uv build --offline` (src-Layout,
  Hatchling-Packages = `src/typesafe_jev`).
- Deployment: Teil des `promote`-Laufs aus `harness_test` (Verzeichnis `skills/typesafe-jev`);
  Gegenstück-Host-Modul: `extensions/typesafe-bridge` (README dort). Skill und Bridge werden als
  Paar ausgeliefert/versioniert (beide 0.1.0; Envelope/Receipt `prime-jev/call/2`).
