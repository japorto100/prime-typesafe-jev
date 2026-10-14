"""Ported probes from archive/2026-09-23-jev-review/checks/check_client.py (7 probes).

Phase 1: the confirmed gaps now assert the FIXED behavior; J07 stays a characterization
(legacy scalars block the loop — documented, new code uses `system_one_async`).
The archived review package stays the historical counter-evidence.

Run: uv run --offline --no-project --with pytest pytest skills/typesafe-jev/tests -q
"""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
import sys

import pytest

SRC = pathlib.Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))
os.environ["PRIME_JEV_SOCKET"] = "/nonexistent/offline-audit-socket"

import typesafe_jev as j  # noqa: E402  (import after env/path setup)

QUESTIONS = {"q": {"type": "noul", "instructions": "X", "criteria": None}}


def _raising_bridge(method: str, params: dict) -> dict:
    raise RuntimeError("JevBridgeError: socket communication failed")


# --- unbound bridge: error, never a fabricated result (J05) -------------------


def test_system_one_rejects_unbound_bridge() -> None:
    with pytest.raises(RuntimeError, match="JevBridgeError"):
        j.system_one("x", {"q": {"type": "noul", "instructions": "X"}})


def test_decide_rejects_unbound_bridge() -> None:
    with pytest.raises(RuntimeError, match="JevBridgeError"):
        j.decide("noul", condition="x")


def test_generic_run_rejects_unbound_bridge() -> None:
    with pytest.raises(RuntimeError, match="JevBridgeError"):
        asyncio.run(j.run("system_one", state="x", questions={"q": {"type": "noul", "instructions": "X"}}))


# --- mock results are rejected on every path (J05) ----------------------------


def test_system_one_rejects_mock_result(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(j, "_call_bridge", lambda method, params: {"mock": True, "answers": {"q": {"type": "noul", "noul": 0.8}}})
    with pytest.raises(RuntimeError, match="missing batch answers"):
        j.system_one("x", {"q": {"type": "noul", "instructions": "X"}})


def test_decide_rejects_mock_result(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(j, "_call_bridge", lambda method, params: {"mock": True, "status": "ok"})
    with pytest.raises(RuntimeError, match="mock response rejected"):
        j.decide("noul", condition="x")


def test_generic_run_rejects_mock_envelope(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(j, "_call_bridge", lambda method, params: {"mock": True, "status": "ok"})
    with pytest.raises(RuntimeError, match="missing batch answers"):
        asyncio.run(j.run("system_one", state="x", questions={"q": {"type": "noul", "instructions": "X"}}))


# --- J08: run('system_one', context=…) forwards the state ---------------------


def test_generic_run_forwards_context(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[tuple[str, dict]] = []

    def capture(method: str, params: dict) -> dict:
        seen.append((method, params))
        return {"answers": {"q": {"type": "noul", "noul": 0.8}}, "model": "jev-1.13.0", "usage": {}}

    monkeypatch.setattr(j, "_call_bridge", capture)
    asyncio.run(j.run("system_one", context="EXPECTED_CONTEXT", questions={"q": {"type": "noul", "instructions": "X"}}))
    assert seen[-1][0] == "system_one"
    assert seen[-1][1]["state"] == "EXPECTED_CONTEXT"


# --- J06: fallback provenance survives via the explicit container -------------


def test_legacy_fallback_provenance_survives(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(j, "_call_bridge", _raising_bridge)
    value = j.noul("x", condition="x", fallback="fail_open")
    assert bool(value) is True
    assert value.is_fallback is True
    container = j.result(value)
    assert container == {"status": "fallback", "value": True, "provenance": "legacy-fallback"}
    # Counter-check: plain JSON of the value alone is indistinguishable, but the
    # container status separates a fallback from a genuine model answer.
    assert json.dumps(container["value"]) == "true"
    genuine = j.result(j.AwaitableBool(True))
    assert genuine["status"] == "answered"
    assert genuine["status"] != container["status"]


# --- event loop behavior: real async batch vs legacy scalars (J07) ------------


def test_system_one_async_preserves_responsive_event_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    async def compare() -> list[str]:
        events: list[str] = []

        def slow(method: str, params: dict) -> dict:
            import time

            time.sleep(0.06)
            return {"answers": {"q": {"type": "noul", "noul": 0.8}}, "model": "jev-1.13.0", "usage": {}}

        monkeypatch.setattr(j, "_call_bridge", slow)

        async def tick() -> None:
            await asyncio.sleep(0.005)
            events.append("tick")

        task = asyncio.create_task(tick())
        await j.system_one_async("x", {"q": {"type": "noul", "instructions": "X"}})
        events.append("batch_done")
        await task
        return events

    assert asyncio.run(compare()) == ["tick", "batch_done"]


def test_legacy_choice_blocking_characterization(monkeypatch: pytest.MonkeyPatch) -> None:
    async def compare() -> list[str]:
        events: list[str] = []

        def slow(method: str, params: dict) -> dict:
            import time

            time.sleep(0.06)
            return {"choice": "a", "confidence": 0.9, "probabilities": {"a": 0.9, "b": 0.1}}

        monkeypatch.setattr(j, "_call_bridge", slow)

        async def tick() -> None:
            await asyncio.sleep(0.005)
            events.append("tick")

        task = asyncio.create_task(tick())
        await j.choice("x", ["a", "b"])
        events.append("legacy_done")
        await task
        return events

    # Characterization: awaiting the legacy scalar does NOT make the I/O async.
    assert asyncio.run(compare()) == ["legacy_done", "tick"]
