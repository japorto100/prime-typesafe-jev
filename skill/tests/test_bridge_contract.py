"""Bridge wire contract against a fake host socket — offline, no live kernel.

The fake host mirrors extensions/typesafe-bridge/transport.ts: one request per
connection, newline framing, 65536-byte request buffer cap, 1 MiB response cap,
`{result}` / `{error: code}` envelopes and a refusal to send more than the cap.
It proves the SDK contract (framing, limits, error envelope, module-call form)
without installing anything into the live kernel venv.
"""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
import socket
import sys
import tempfile
import threading
from collections.abc import Callable

import pytest

SRC = pathlib.Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

import typesafe_jev as j  # noqa: E402  (import after path setup)

QUESTIONS = {"q": {"type": "noul", "instructions": "X"}}


def _envelope(result: dict) -> bytes:
    return (json.dumps({"result": result}) + "\n").encode()


def _error(code: str) -> bytes:
    return (json.dumps({"error": code}) + "\n").encode()


class FakeHost:
    """One request per connection; deterministic reply; records raw frames."""

    def __init__(self, reply: bytes | Callable[[dict | None], bytes] | None, split: int | None = None):
        self._dir = tempfile.TemporaryDirectory()
        self.path = pathlib.Path(self._dir.name) / "bridge.sock"
        self.reply = reply
        self.split = split
        self.raw: list[bytes] = []
        self.requests: list[dict] = []
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(str(self.path))
        self.server.listen(4)
        self.server.settimeout(5.0)
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self) -> None:
        while True:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            try:
                data = b""
                while b"\n" not in data and len(data) <= 65536:
                    chunk = conn.recv(4096)
                    if not chunk:
                        break
                    data += chunk
                self.raw.append(data)
                request = None
                if b"\n" in data:
                    request = json.loads(data.split(b"\n", 1)[0])
                    self.requests.append(request)
                if self.reply is None:
                    continue  # close without an answer
                payload = self.reply(request) if callable(self.reply) else self.reply
                try:
                    if self.split is not None:
                        conn.sendall(payload[: self.split])
                        conn.sendall(payload[self.split :])
                    else:
                        conn.sendall(payload)
                except OSError:
                    pass  # client closed early (oversize-bound test) — not a server failure
            finally:
                conn.close()

    def stop(self) -> None:
        try:
            self.server.close()
        finally:
            self._dir.cleanup()


@pytest.fixture
def host():
    servers: list[FakeHost] = []

    def start(reply, split: int | None = None) -> FakeHost:
        server = FakeHost(reply, split)
        servers.append(server)
        os.environ["PRIME_JEV_SOCKET"] = str(server.path)
        return server

    yield start
    for server in servers:
        server.stop()
    os.environ.pop("PRIME_JEV_SOCKET", None)


def test_system_one_round_trip_over_real_socket(host):
    reply = _envelope({"answers": {"q": {"type": "noul", "noul": 0.8}}, "model": "jev-1.13.0"})
    server = host(reply)
    result = j.system_one("ctx", QUESTIONS)
    assert result["answers"]["q"]["noul"] == 0.8
    request = server.requests[0]
    assert request["method"] == "system_one"
    assert request["params"]["state"] == "ctx"
    assert request["params"]["questions"] == QUESTIONS
    assert request["caller"]["pid"] == os.getpid()


def test_reply_split_across_reads_is_reassembled(host):
    host(_envelope({"answers": {"q": {"type": "noul", "noul": 0.4}}}), split=7)
    assert j.system_one("ctx", QUESTIONS)["answers"]["q"]["noul"] == 0.4


def test_system_one_async_round_trip(host):
    host(_envelope({"answers": {"q": {"type": "noul", "noul": 0.6}}}))
    result = asyncio.run(j.system_one_async("ctx", QUESTIONS))
    assert result["answers"]["q"]["noul"] == 0.6


def test_run_module_call_form_reaches_the_bridge(host):
    server = host(_envelope({"answers": {"q": {"type": "noul", "noul": 0.9}}}))
    out = asyncio.run(j.run("system_one", {"x": 1}, QUESTIONS))
    assert out["answers"]["q"]["noul"] == 0.9
    assert server.requests[0]["method"] == "system_one"
    assert server.requests[0]["params"]["state"] == {"x": 1}


def test_run_unknown_method_surfaces_the_host_error(host):
    host(lambda request: _error("JevProviderUnsupported"))
    with pytest.raises(RuntimeError, match="JevRPCError: JevProviderUnsupported"):
        asyncio.run(j.run("nonsense", "ctx"))


def test_request_frame_guard_counts_the_newline(host, monkeypatch):
    server = host(_envelope({"answers": {"q": {"type": "noul", "noul": 0.8}}}))
    state = "x" * 100
    j.system_one(state, QUESTIONS)
    frame_len = len(server.raw[0])  # payload + b"\n", what the host caps at 65536
    monkeypatch.setattr(j, "MAX_PAYLOAD_BYTES", frame_len)
    j.system_one(state, QUESTIONS)  # exactly at the cap is still admitted
    monkeypatch.setattr(j, "MAX_PAYLOAD_BYTES", frame_len - 1)
    with pytest.raises(ValueError, match="JevRequestTooLarge"):
        j.system_one(state, QUESTIONS)
    assert len(server.requests) == 2, "the oversized request never reached the host"


def test_host_error_code_maps_to_rpc_error(host):
    host(_error("JevBudgetExceeded"))
    with pytest.raises(RuntimeError, match=r"^JevRPCError: JevBudgetExceeded$"):
        j.system_one("ctx", QUESTIONS)


def test_mock_envelope_is_rejected_over_socket(host):
    host(_envelope({"mock": True, "answers": {"q": {"type": "noul", "noul": 1.0}}}))
    with pytest.raises(RuntimeError, match="mock bridge response"):
        j.system_one("ctx", QUESTIONS)


def test_oversized_reply_is_bounded_client_side(host):
    host(b"x" * (1024 * 1024 + 1))  # no newline; the client must cap the read
    with pytest.raises(RuntimeError, match="1 MiB budget"):
        j.system_one("ctx", QUESTIONS)


def test_empty_reply_is_an_error(host):
    host(None)
    with pytest.raises(RuntimeError, match="Leere Antwort"):
        j.system_one("ctx", QUESTIONS)
