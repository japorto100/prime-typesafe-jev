# Architecture: prime-typesafe-jev

`prime-typesafe-jev` provides a hardened **System-1 decision model integration and safety governance layer** for [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent).

It bridges fast, calibrated, non-autoregressive decision models (such as [TypeSafe JEV](https://typesafe.ai) or local clones like [`capitaharlock/jev-clone`](https://github.com/capitaharlock/jev-clone)) with the Prime Agent execution environment, while enforcing a deterministic security floor, secret redaction, and strict authority boundaries.

---

## Architecture Diagram

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        Prime Agent Process                             │
│                                                                        │
│  ┌──────────────────────────────────┐                                  │
│  │   Python Kernel Runtime          │                                  │
│  │   (Skill: typesafe-jev)          │                                  │
│  │                                  │                                  │
│  │   system_one_async(state, q)     │                                  │
│  │   choice() / score() / noul()    │                                  │
│  └──────────────────┬───────────────┘                                  │
│                     │                                                  │
│                     │ Private Unix Domain Socket                       │
│                     │ (PRIME_JEV_SOCKET, 0o700 dir, 0o600 socket)      │
│                     ▼                                                  │
│  ┌──────────────────────────────────┐                                  │
│  │   Host Extension                 │                                  │
│  │   (Extension: typesafe-bridge)   │                                  │
│  │                                  │                                  │
│  │   ┌───────────────────────────┐  │                                  │
│  │   │  Deterministic Floor      │  │                                  │
│  │   │  (Hard blocks & tripwires)│  │                                  │
│  │   └──────────────┬────────────┘  │                                  │
│  │                  │               │                                  │
│  │   ┌──────────────▼────────────┐  │                                  │
│  │   │  Egress Redactor          │  │                                  │
│  │   │  (Strips tokens/secrets)  │  │                                  │
│  │   └──────────────┬────────────┘  │                                  │
│  │                  │               │                                  │
│  │   ┌──────────────▼────────────┐  │                                  │
│  │   │  Budget & Rate Breaker    │  │                                  │
│  │   │  (Kill-switch & limits)   │  │                                  │
│  │   └──────────────┬────────────┘  │                                  │
│  │                  │               │                                  │
│  │   ┌──────────────▼────────────┐  │      HTTPS / IPC                 │
│  │   │  Provider Seam            ├──┼────────────────────► Backends    │
│  │   │  (Pluggable routing)      │  │                                  │
│  │   └──────────────┬────────────┘  │                     • api.typesafe.ai
│  │                  │               │                     • Local jev-clone
│  │   ┌──────────────▼────────────┐  │                     • Custom Engine
│  │   │  Receipts v2 & Eval Log   │  │                                  │
│  │   │  (Content-free audit)     │  │                                  │
│  │   └───────────────────────────┘  │                                  │
│  └──────────────────────────────────┘                                  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Core Invariants

### 1. Strict Authority Model (Proposals, Not Authority Tokens)
* **JEV decisions are judgments/proposals, never authority tokens.**
* A high confidence score from a decision model **never equals a PASS** and never overrides deterministic checks, test results, or verification assertions.
* The decision model guides search, prioritization, and advisory routing; deterministic tools and humans retain final authority.

### 2. The Deterministic Security Floor
* Tool gating does not delegate safety to a probabilistic model.
* A two-stage deterministic floor (`core/floor.ts`) intercepts dangerous patterns (e.g. destructive commands, raw file deletions, credential access) and triggers immediate hard blocks or human-in-the-loop (HITL) confirmations.
* JEV is evaluated strictly in the advisory/grey zone, never as the perimeter firewall.

### 3. Secret Isolation & Zero-Leakage Socket
* The Python kernel skill **never holds or sees upstream API keys or credentials**.
* Communication occurs strictly over a private Unix Domain Socket (`PRIME_JEV_SOCKET`) created under a restricted temporary directory (`0o700`) with permissions `0o600`.
* The host-level **Egress Redactor** (`core/redactor.ts`) strips API tokens, SSH keys, bearer tokens, and private paths before payloads leave the host.

### 4. Pluggable Providers (Cloud & Local)
The host bridge decouples the client from the upstream provider via `core/provider.ts`:
* **Upstream Cloud:** Default routing to `api.typesafe.ai/v1/systemone` using standard Jev endpoints.
* **Local Inference:** Easily bound to local high-performance System-1 engines (such as Candle-based Rust servers like `capitaharlock/jev-clone` or local ONNX runtimes) via `PRIME_JEV_PROVIDER` or local socket proxies.

### 5. Sound Error Semantics (`unavailable != false`)
* In `prime-typesafe-jev`, an unavailable service, network timeout, or budget rejection is **never conflated with a negative answer (`false` / `0.0`)**.
* Missing bridges or transport errors raise explicit `JevBridgeError` or `JevRPCError` exceptions. Silent fallbacks or synthetic mock successes are rejected.

### 6. Content-Free Audit Receipts
* Every evaluation generates a structured receipt under `~/.prime/agent/receipts/jev.calls.jsonl` adhering to schema `prime-jev/call/2`.
* Receipts capture model metadata, bytes transferred, latency, redaction counts, and outcome categories **without storing user prompts, raw tool inputs, or code snippets**.
