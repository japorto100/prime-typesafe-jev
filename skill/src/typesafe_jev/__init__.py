"""TypeSafe Jev Client für den Prime Agent IPython Kernel.

Communicates through PRIME_JEV_SOCKET inherited from the host extension.
Credentials are not part of the RPC payload; same-user processes are not isolated
from each other's credential files by this transport. The socket path is read from
os.environ on every call, so a running kernel keeps working across host reloads.
"""

from __future__ import annotations

import json
import os
import socket
from pathlib import Path
from typing import Any

__all__ = ["choice", "decide", "noul", "result", "run", "score", "system_one", "system_one_async"]

# Wire budget of the host bridge: transport.ts rejects any request buffer > 65536 bytes,
# and the frame is `payload + b"\n"`. The local guard therefore counts the newline too.
MAX_PAYLOAD_BYTES = 64 * 1024


def _socket_path() -> Path:
    """Per-call read (Part of Variant A): a stable endpoint is the real guarantee."""
    return Path(os.environ.get("PRIME_JEV_SOCKET", "/nonexistent/prime-jev-unbound"))


def _call_bridge(method: str, params: dict[str, Any]) -> dict[str, Any]:
    """Sendet einen Request an den Unix-Domain-Socket der Node-Bridge."""
    socket_path = _socket_path()
    payload = {
        "method": method,
        "params": params,
        "caller": {
            "pid": os.getpid(),
            "reported_depth": os.environ.get("RLM_DEPTH"),
        },
    }
    raw_data = json.dumps(payload).encode("utf-8")

    # 64 KiB Payload-Schutz des Hosts, inklusive des abschliessenden Newline-Frames.
    if len(raw_data) + 1 > MAX_PAYLOAD_BYTES:
        raise ValueError("JevRequestTooLarge: request exceeds local 64 KiB budget")

    # Kein Mock-/Dry-Run-Fallback: eine ungebundene Bridge ist ein Fehler, keine Vorhersage.
    if not socket_path.exists():
        raise RuntimeError(
            f"JevBridgeError: Unix-Socket '{socket_path}' nicht gefunden. "
            "Läuft der Prime Agent Outer Harness mit der typesafe-bridge Extension?"
        )

    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(2.0)  # 2.0s Timeout gegen Koma-Freezes im Programmier-Loop
    try:
        client.connect(str(socket_path))
        client.sendall(raw_data + b"\n")

        # Antwort lesen
        response_chunks = []
        response_size = 0
        while True:
            chunk = client.recv(4096)
            if not chunk:
                break
            response_chunks.append(chunk)
            response_size += len(chunk)
            if response_size > 1024 * 1024:
                raise RuntimeError("JevBridgeError: response exceeds local 1 MiB budget")
            if b"\n" in chunk:
                break

        response_bytes = b"".join(response_chunks).strip()
        if not response_bytes:
            raise RuntimeError("JevBridgeError: Leere Antwort von der Unix-Socket-Bridge erhalten.")

        data = json.loads(response_bytes.decode("utf-8"))
        if "error" in data:
            raise RuntimeError(f"JevRPCError: {data['error']}")
        result = data.get("result", data)
        if not isinstance(result, dict) or result.get("mock") is True:
            raise RuntimeError("JevInvalidDecision: malformed or mock bridge response")
        return result

    except (TimeoutError, OSError) as e:
        raise RuntimeError(
            f"JevBridgeError: Socket-Kommunikation fehlgeschlagen ({type(e).__name__}): {e}"
        ) from None
    finally:
        client.close()


def system_one(state: Any, questions: dict[str, Any]) -> dict[str, Any]:
    """Evaluate independent questions together; retain probabilities, model and usage.

    No implicit boolean conversion, authorization policy or synthetic fallback.
    """
    if not isinstance(questions, dict) or not questions:
        raise ValueError("questions must be a nonempty map")
    result = _call_bridge("system_one", {"state": state, "questions": questions})
    if result.get("mock") or not isinstance(result.get("answers"), dict):
        raise RuntimeError("JevInvalidDecision: missing batch answers")
    if not questions.keys() <= result["answers"].keys():
        raise RuntimeError("JevInvalidDecision: incomplete batch")
    return result


async def system_one_async(state: Any, questions: dict[str, Any]) -> dict[str, Any]:
    """Real async wrapper: socket I/O does not block the caller's event loop."""
    import asyncio

    return await asyncio.to_thread(system_one, state, questions)


class AwaitableStr(str):
    """String-Rückgabe, die sowohl synchron als auch mit await aufgerufen werden kann.

    Awaiting is compatibility sugar only: the underlying bridge I/O stays synchronous
    and still blocks the event loop (characterized in the tests). New code uses
    `system_one_async`.
    """

    def __await__(self):
        async def _wrapper():
            return str(self)

        return _wrapper().__await__()


class AwaitableFloat(float):
    """Float-Rückgabe, die sowohl synchron als auch mit await aufgerufen werden kann."""

    def __await__(self):
        async def _wrapper():
            return float(self)

        return _wrapper().__await__()


class AwaitableBool(int):
    """Legacy boolean adapter; awaiting it does not make the preceding I/O asynchronous."""

    def __new__(cls, val: Any):
        return super().__new__(cls, 1 if val else 0)

    def __repr__(self) -> str:
        return "True" if self else "False"

    def __str__(self) -> str:
        return "True" if self else "False"

    def __await__(self):
        async def _wrapper():
            return bool(self)

        return _wrapper().__await__()


class FallbackStr(AwaitableStr):
    """Explicit legacy fallback; provenance survives via `result()` (J06)."""

    is_fallback = True


class FallbackFloat(AwaitableFloat):
    """Explicit legacy fallback; provenance survives via `result()` (J06)."""

    is_fallback = True


class FallbackBool(AwaitableBool):
    """Explicit legacy fallback; provenance survives via `result()` (J06)."""

    is_fallback = True


def result(value: Any) -> dict[str, Any]:
    """Explicit result container (R3): status answered|fallback + provenance.

    Plain serialization of a legacy scalar loses the fallback mark; this container is
    the counter-check path that keeps a fallback distinguishable from a model answer.

    `unavailable` is not a value state: a missing bridge, transport failure, RPC
    rejection or mock response raises (`JevBridgeError`/`JevRPCError`/
    `JevInvalidDecision`) and must never be converted into False, "unknown" or a
    silent fallback. A model answer such as noul=False or choice="unknown" is a
    negative classification, not unavailability.
    """
    is_fallback = bool(getattr(value, "is_fallback", False))
    if isinstance(value, AwaitableBool):
        plain: Any = bool(value)
    elif isinstance(value, AwaitableFloat):
        plain = float(value)
    elif isinstance(value, AwaitableStr):
        plain = str(value)
    else:
        plain = value
    return {
        "status": "fallback" if is_fallback else "answered",
        "value": plain,
        "provenance": "legacy-fallback" if is_fallback else "model",
    }


def choice(
    context: str,
    choices: list[str] | None = None,
    task: str | None = None,
    options: list[str] | None = None,
    instructions: str | None = None,
    fallback: str | None = None,
    **kwargs: Any,
) -> AwaitableStr:
    """Legacy scalar adapter for a probabilistic choice.

    Funktioniert synchron ('res = choice(...)') und asynchron ('res = await choice(...)');
    awaiting does not make the preceding I/O asynchronous. Neue Nutzung: system_one_async.

    Args:
        context: Eingabe-Zustand (Code, Diff, Log, Text).
        choices: Liste von 1 bis 32 Optionen (Alias: 'options').
        task: Optionale Aufgabenbeschreibung / Frage (Alias: 'instructions').
        fallback: Explicit legacy fallback (marked via FallbackStr, J06).

    Returns:
        Der gewählte Options-String (AwaitableStr).
    """
    resolved_choices = choices or options or kwargs.get("choices") or kwargs.get("options") or []
    if not resolved_choices:
        raise ValueError("choice() erfordert eine Liste von Optionen via 'choices' oder 'options'.")
    if len(resolved_choices) > 32:
        raise ValueError("Choices müssen zwischen 1 und 32 Optionen umfassen.")

    resolved_task = task or instructions or kwargs.get("task") or kwargs.get("instructions")
    try:
        res = _call_bridge(
            "choice",
            {
                "context": context,
                "choices": resolved_choices,
                "task": resolved_task,
                **kwargs,
            },
        )
        if res.get("mock") or res.get("choice") not in resolved_choices:
            raise RuntimeError("JevInvalidDecision: missing, mock or out-of-set choice")
        return AwaitableStr(res["choice"])
    except Exception:
        if fallback is not None and fallback != "raise":
            if fallback == "first" or fallback == "heuristic":
                return FallbackStr(resolved_choices[0])
            return FallbackStr(str(fallback))
        raise


def score(
    context: str,
    criterion: Any | None = None,
    rubric: list[str] | None = None,
    criteria: list[str] | None = None,
    instructions: str | None = None,
    task: str | None = None,
    fallback: Any | None = None,
    **kwargs: Any,
) -> AwaitableFloat:
    """Bewertet den Kontext anhand einer geordneten Rubrik (2 bis 10 Level).

    Funktioniert synchron ('s = score(...)') und asynchron ('s = await score(...)').

    Args:
        context: Eingabe-Zustand.
        criterion: Beschreibung der Bewertung oder Rubrik.
        rubric: Geordnete Liste von 2 bis 10 Bewertungsstufen (Alias: 'criteria').
        instructions: Spezifische Frage / Anweisung für die Bewertung.
        fallback: Explicit legacy numeric fallback (marked via FallbackFloat, J06).

    Returns:
        Fließkomma-Score (AwaitableFloat).
    """
    resolved_criteria = criteria or rubric or kwargs.get("criteria") or kwargs.get("rubric")
    if isinstance(criterion, list) and not resolved_criteria:
        resolved_criteria = criterion
        criterion = None

    resolved_instructions = (
        instructions
        or task
        or (criterion if isinstance(criterion, str) else None)
        or kwargs.get("instructions")
    )

    params: dict[str, Any] = {
        "context": context,
        "criterion": criterion if isinstance(criterion, str) else None,
        "instructions": resolved_instructions,
        "criteria": resolved_criteria,
        **kwargs,
    }
    try:
        res = _call_bridge("score", params)
        import math

        value = res.get("score")
        if res.get("mock") or isinstance(value, bool) or not isinstance(value, (int, float)):
            raise RuntimeError("JevInvalidDecision: invalid score type")
        if not math.isfinite(value):
            raise RuntimeError("JevInvalidDecision: missing, mock or invalid score")
        return AwaitableFloat(value)
    except Exception:
        if fallback is not None and fallback != "raise":
            if fallback == "heuristic":
                return FallbackFloat(0.5)
            return FallbackFloat(float(fallback))
        raise


def noul(
    context: str,
    condition: str | None = None,
    statement: str | None = None,
    invariant: str | None = None,
    instructions: str | None = None,
    fallback: Any | None = None,
    **kwargs: Any,
) -> AwaitableBool:
    """Fällt ein binäres Urteil (True/False) über eine prüfbare Aussage.

    WICHTIG (TypeSafe-Konvention): 'condition' ist eine eng formulierte, prüfbare
    Ja/Nein-Aussage — die Frageform ist zulässig (TypeSafe dokumentiert Noul als
    Ja/Nein-Frage); entscheidend ist die Eindeutigkeit des Sachverhalts.

    Funktioniert synchron ('ok = noul(...)') und asynchron ('ok = await noul(...)').

    Args:
        context: Eingabe-Zustand.
        condition: Zu prüfende Aussage (Alias: 'statement', 'invariant').
        fallback: 'fail_closed', 'fail_open', bool, or 'raise' (marked via FallbackBool, J06).

    Returns:
        True oder False (AwaitableBool).
    """
    resolved_condition = (
        condition
        or statement
        or invariant
        or instructions
        or kwargs.get("condition")
        or "Invariante ist erfüllt."
    )
    try:
        res = _call_bridge(
            "noul",
            {
                "context": context,
                "condition": resolved_condition,
                **kwargs,
            },
        )
        if res.get("mock") or type(res.get("verdict")) is not bool:
            raise RuntimeError("JevInvalidDecision: missing, mock or invalid verdict")
        return AwaitableBool(res["verdict"])
    except Exception:
        if fallback is not None and fallback != "raise":
            if fallback == "fail_closed":
                return FallbackBool(False)
            if fallback == "fail_open":
                return FallbackBool(True)
            return FallbackBool(bool(fallback))
        raise


def decide(method: str, **params: Any) -> dict[str, Any]:
    """Generischer Entscheidungsaufruf mit vollständiger Rückgabe (inkl. Konfidenz).

    Mock-Antworten werden verworfen (kein Fake-Erfolg auf Produktionspfaden, J05).
    """
    response = _call_bridge(method, params)
    if isinstance(response, dict) and response.get("mock") is True:
        raise RuntimeError("JevInvalidDecision: mock response rejected")
    return response


async def run(method: str = "choice", *args: Any, **kwargs: Any) -> Any:
    """Dispatch a JEV call; the kernel exposes this as the module callable.

    Calling the module directly forwards to `run()` (Prime skill convention), e.g.
    ``await typesafe_jev("system_one", state, questions)`` or
    ``await typesafe_jev("noul", context, condition)``. Prefer importing
    `system_one_async` explicitly in new code; the method-first form exists so the
    bare skill call has a defined meaning. Unknown method names surface the host's
    `JevProviderUnsupported` error instead of guessing a method.
    """
    kwargs_clean = dict(kwargs)
    ctx = kwargs_clean.pop("context", args[0] if args else "")
    if method == "choice":
        ch = (
            kwargs_clean.pop("choices", None)
            or kwargs_clean.pop("options", None)
            or (args[1] if len(args) > 1 else [])
        )
        return await choice(ctx, ch, **kwargs_clean)
    elif method == "score":
        crit = (
            kwargs_clean.pop("criterion", None)
            or kwargs_clean.pop("criteria", None)
            or kwargs_clean.pop("rubric", None)
            or (args[1] if len(args) > 1 else None)
        )
        return await score(ctx, crit, **kwargs_clean)
    elif method == "noul":
        cond = (
            kwargs_clean.pop("condition", None)
            or kwargs_clean.pop("statement", None)
            or kwargs_clean.pop("invariant", None)
            or (args[1] if len(args) > 1 else None)
        )
        return await noul(ctx, cond, **kwargs_clean)
    elif method == "system_one":
        state = kwargs_clean.pop("state", ctx)
        questions = kwargs_clean.pop("questions", args[1] if len(args) > 1 else None)
        return await system_one_async(state, questions)
    return decide(method, **kwargs_clean)
