# prime-typesafe-jev

> **System-1 Decision Model Integration, Safety Governance, and Host Bridge for Prime Agent**

[![Tests](https://img.shields.io/badge/tests-185%20passing-brightgreen)](#testing)
[![Version](https://img.shields.io/badge/version-v0.1.0-blue)](#status)
[![Platform](https://img.shields.io/badge/Platform-Linux%20%7C%20macOS%20(POSIX%20only)-success)](#system-requirements)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Target](https://img.shields.io/badge/Target-Prime%20Agent%20v0.9.8%2B-orange)](#modes-of-operation)

---

## Overview

`prime-typesafe-jev` brings **System-1 decision models** into [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent).

Standard LLMs rely on autoregressive token generation, incurring high latency, non-deterministic formatting, and prompt bloat. In contrast, **System-1 models** (such as [TypeSafe JEV](https://typesafe.ai) or local engines like [`capitaharlock/jev-clone`](https://github.com/capitaharlock/jev-clone)) take a structured state representation and emit calibrated categorical probability distributions over dynamic choices in single-digit milliseconds.

However, plugging a decision model directly into an autonomous agent poses major operational hazards: credential exposure, probabilistic tool safety, runaway API budgets, and leaked sensitive context. 

`prime-typesafe-jev` provides the complete **host governance and bridge harness**:
* **Zero Credential Exposure:** Python skills never touch upstream API keys; all traffic routes through a private Unix Domain Socket (`PRIME_JEV_SOCKET`, permissions `0o600`).
* **Deterministic Security Floor:** Hard blocks and tripwires for destructive actions (`rm -rf`, raw disk writes, credential theft). Probabilistic decisions are restricted to the advisory grey-zone.
* **Egress Redactor:** Automatically strips secrets, tokens, and sensitive private paths before data leaves the machine.
* **Persistent Daily Budget:** Hard caps on daily spend with emergency kill-switch (`PRIME_JEV_BUDGET_KILL=1`) and rolling-minute rate limiting.
* **Dual-Channel Observability:** Content-free receipts (`prime-jev/call/2`) and an isolated telemetry eval channel (`prime-jev/eval/1`).
* **Provider Neutral:** Works out-of-the-box with TypeSafe AI cloud endpoints or local self-hosted inference servers.

Detailed architectural analysis: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Project Structure

The repository is organized into two cooperating components:

```text
prime-typesafe-jev/
├── extension/             # TypeScript Host Extension (Bridge & Safety Floor)
│   ├── index.ts           # Extension entrypoint, lifecycle, and hook wiring
│   ├── transport.ts       # Private Unix Domain Socket (UDS) server
│   ├── core/              # Security floor, redactor, budget, provider seam
│   ├── hooks/             # Router, tool-gate, watchdog, triage, compaction
│   └── tests/             # 161 unit, integration, and adversarial tests
├── skill/                 # Python Kernel Skill (Client API & Recipes)
│   ├── src/typesafe_jev/  # Async Python client (system_one_async, choice, score, noul)
│   ├── tests/             # 24 contract and recipe tests
│   └── SKILL.md           # Agent-facing skill documentation
├── docs/                  # Architecture and design specifications
├── LICENSE                # MIT License
└── package.json           # Root tooling and test runners
```

---

## Python Client API (`skill/`)

Install or link `skill/` into your Prime Agent environment (`~/.prime/agent/skills/typesafe-jev`):

```python
from typesafe_jev import system_one_async, choice, score, noul

# 1. Native Asynchronous Batch Decision
assessment = await system_one_async(
    state={
        "task": "Refactor database migration handler",
        "diff_summary": "+12 -4 lines in storage.ts",
        "observations": "All unit tests pass, no schema change"
    },
    questions={
        "safe_to_merge": {
            "type": "noul",
            "instructions": "Is this change free from breaking API changes?"
        },
        "next_step": {
            "type": "choice",
            "instructions": "Which action should the agent execute next?",
            "criteria": {
                "run_tests": "Run the integration suite",
                "request_review": "Request human approval",
                "proceed": "Commit and push"
            }
        },
        "risk_level": {
            "type": "score",
            "instructions": "Assess the blast radius of this change",
            "criteria": ["trivial", "component-local", "cross-module", "system-wide"]
        }
    }
)

answers = assessment["answers"]
print("Merge Safe?", answers["safe_to_merge"]["answer"])  # True / False
print("Recommended Action:", answers["next_step"]["choice"])
```

### Supported Decision Primitives

| Method | Role | Description |
|---|---|---|
| `system_one_async` | **Preferred** | Non-blocking native batch of heterogeneous questions against shared state. |
| `noul(state, condition)` | Boolean Judgement | Calibrated Yes/No probability for tightly specified, verifiable claims. |
| `choice(state, criteria)` | Categorical Selection | Probability distribution over dynamic candidate keys with optional abstention (`unknown`). |
| `score(state, rubric)` | Ordinal Evaluation | Ordered rubric evaluation across 2–10 discrete levels. |

---

## Host Extension (`extension/`)

The host extension runs within the Prime Agent daemon or as an isolated sidecar, creating the IPC bridge and intercepting lifecycle events.

### Hook Rollout Ladder

To ensure safe deployment, every hook follows a strict 5-stage rollout progression:
```text
off  ──►  G1 (Data Grant)  ──►  shadow  ──►  advisory  ──►  live
```
* `off`: Default state; no sockets opened, zero overhead.
* `G1`: Explicit environment approval granting permission to evaluate specific data categories (e.g. `PRIME_JEV_G1=tool-gate:tool-input`).
* `shadow`: Runs in the background, records receipts and eval metrics, but never intervenes in agent execution.
* `advisory`: Injects contextual hints into prompt or UI when model confidence crosses configured thresholds.
* `live`: Actively gates execution (triggers Human-In-The-Loop confirmations for risky operations).

---

## Configuration Reference

Settings can be specified via environment variables or within `.prime/agent/settings.json`:

| Environment Variable | Settings Key | Description | Default |
|---|---|---|---|
| `PRIME_JEV_HOOK_ROUTER` | `extensionConfig.jev.hooks.router` | Hook mode for skill routing | `off` |
| `PRIME_JEV_HOOK_TOOL_GATE` | `extensionConfig.jev.hooks.tool_gate` | Hook mode for tool execution gating | `off` |
| `PRIME_JEV_HOOK_WATCHDOG` | `extensionConfig.jev.hooks.watchdog` | Hook mode for turn drift watchdog | `off` |
| `PRIME_JEV_HOOK_RESULT_TRIAGE` | `extensionConfig.jev.hooks.result_triage` | Hook mode for large output triage | `off` |
| `PRIME_JEV_G1` | *(Env-only)* | Mandatory comma-separated data class grants | *(None)* |
| `PRIME_JEV_BUDGET_KILL` | *(Env-only)* | Emergency kill-switch (`1` immediately blocks all calls) | `0` |
| `PRIME_JEV_EGRESS` | *(Env-only)* | Secret redactor mode (`redact` \| `block` \| `off`) | `redact` |
| `PRIME_JEV_PROVIDER` | `extensionConfig.jev.provider` | Provider backend ID (`jev` \| custom) | `jev` |
| `PRIME_JEV_EVAL` | *(Env-only)* | Enable telemetry evaluation logging | `0` |

---

## Testing

The project maintains a rigorous, offline test suite covering contract invariants, adversarial inputs, rate limits, and redactor evasion:

```bash
# 1. Run Node.js extension test suite (161 tests)
npm test

# 2. Run Python skill test suite (24 tests)
npm run test:python

# 3. TypeScript typecheck
npm run typecheck

# 4. Smoke test under simulated Prime runtime
npm run smoke
```

---

## Compatibility with Local Models (`jev-clone`)

While `prime-typesafe-jev` connects upstream to `api.typesafe.ai` by default, its provider seam (`extension/core/provider.ts`) is designed to pair seamlessly with local non-autoregressive engines such as [`capitaharlock/jev-clone`](https://github.com/capitaharlock/jev-clone). Pointing the bridge to a local Candle/Rust daemon allows completely offline, zero-network System-1 inference with sub-5ms latencies.

---

## License

MIT License. See [LICENSE](LICENSE) for details.
