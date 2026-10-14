# Router-Eval — Label-Regeln (`eval/router-tasks.json`)

Verbindliche Kuratierungsregeln für `allowed`-Labels der Router-Aufgaben. Herkunft: J4-Label-Review
30.09.2026 (`archive/2026-10-01-jev-papers/papers/runs/2026-09-30-open-items/J4-LABEL.md`); Umsetzung V1 (Owner-Go 30.09.).

1. **Leitfrage:** „Welche **Skill-Nutzung** wäre als erste Handlung für diesen Prompt akzeptabel?" —
   **nicht** „welches Skill ist thematisch verwandt?".
2. **Positives Label** (`allowed` nicht leer) nur bei **Nutzungsabsicht** (Handlungsverb + Ziel/Artefakt);
   `allowed` = Menge akzeptabler **erster Nutzungen**.
3. **`allowed: []`** genau dann, wenn **keine** Skill-Nutzung angebracht ist: triviale Fragen, Smalltalk,
   **Wissens-/Abgrenzungsfragen über einen Dienst** (z. B. `jev-boundary`).
4. **Kein Namens-Leak:** Der Prompt nennt den Lösungsskill nicht wörtlich (Domain-Token wie „JEV" sind ok).
5. **Nachweis je Task:** `kind`/`note` (optional, schema-verträglich — der Harness liest nur `id`, `prompt`,
   `allowed`) + Kuratierungsdatum.
6. **Kennzahlen trennen:** positives Routing (`hit@1`) und Abstention-/Boundary-Korrektheit getrennt
   ausweisen; Abgrenzungsfragen nie als positive Routen-Treffer umbuchen. (Getrennte Auswertung im Harness
   ist ein **separater, kleiner Schritt** — hier nur die Labelseite.)
7. **Versionierung:** Label-Änderungen erzeugen eine neue Labels-Version (Datei+Datum); alte Reports
   bleiben unverändert (keine rückdatierte Neudeutung).

Status 30.09.: `jev-boundary` → `allowed: []` + `kind: abstention-knowledge` (V1). Variante V2 (zusätzlicher
positiver Task mit Nutzungsabsicht) bleibt als Kuratierungsvorschlag offen (Owner).
