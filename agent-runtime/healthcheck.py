"""Liveness/health HTTP server for EigenCompute health probes.

A tiny stdlib-only HTTP server that runs in a background thread alongside the
agent loop. EigenCompute (and NemoClaw's supervisor) probe `$PORT` (default
8080) to decide whether the sandboxed container is alive. We expose:

  GET /            -> 200 if the process is up
  GET /healthz     -> 200 if the agent ticked within `LIVENESS_TIMEOUT_S`,
                      else 503 (stale / wedged loop)
  GET /livez       -> 200 always-as-long-as-the-process-serves (pure liveness)

The agent loop calls `beat()` on every tick (see entrypoint.py) so /healthz
reflects real trading-loop progress, not just "the web server is up". No
third-party deps: NemoClaw's syscall/fs allowlist is happiest with stdlib.
"""

from __future__ import annotations

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


# How long the loop may go between ticks before /healthz reports unhealthy.
# Defaults to 4x the strategy's default tick (30s) with headroom.
LIVENESS_TIMEOUT_S = float(os.environ.get("LIVENESS_TIMEOUT_S", "180"))


class _State:
    """Shared liveness state, written by the agent thread, read by HTTP."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.started_at = time.time()
        self.last_tick = 0.0
        self.tick_count = 0
        self.tee_wallet: str | None = None
        self.vault_address: str | None = None
        self.last_error: str | None = None

    def beat(self, *, error: str | None = None) -> None:
        with self._lock:
            self.last_tick = time.time()
            self.tick_count += 1
            self.last_error = error

    def set_identity(self, tee_wallet: str | None, vault_address: str | None) -> None:
        with self._lock:
            self.tee_wallet = tee_wallet
            self.vault_address = vault_address

    def snapshot(self) -> dict:
        with self._lock:
            now = time.time()
            stale = self.last_tick > 0 and (now - self.last_tick) > LIVENESS_TIMEOUT_S
            # Before the first tick the agent is still booting (binding
            # attestation, registering the Lighter API key): treat as healthy.
            healthy = (self.tick_count == 0) or (not stale)
            return {
                "healthy": healthy,
                "uptime_s": round(now - self.started_at, 1),
                "tick_count": self.tick_count,
                "seconds_since_last_tick": (
                    round(now - self.last_tick, 1) if self.last_tick else None
                ),
                "tee_wallet": self.tee_wallet,
                "vault_address": self.vault_address,
                "last_error": self.last_error,
            }


STATE = _State()


class _Handler(BaseHTTPRequestHandler):
    # Silence default request logging; NemoClaw/EigenCompute capture stdout and
    # we don't want a health probe flooding the trade logs.
    def log_message(self, *args) -> None:  # noqa: D401
        return

    def _write(self, code: int, body: dict) -> None:
        payload = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path in ("/", "/livez"):
            self._write(200, {"status": "ok", **STATE.snapshot()})
        elif path == "/healthz":
            snap = STATE.snapshot()
            self._write(200 if snap["healthy"] else 503, snap)
        else:
            self._write(404, {"error": "not found"})


def serve(port: int | None = None) -> ThreadingHTTPServer:
    """Start the health server in a daemon thread and return it."""
    port = port or int(os.environ.get("PORT", "8080"))
    httpd = ThreadingHTTPServer(("0.0.0.0", port), _Handler)
    t = threading.Thread(target=httpd.serve_forever, name="healthcheck", daemon=True)
    t.start()
    return httpd


if __name__ == "__main__":
    # Allow running standalone for a quick probe test.
    srv = serve()
    print(f"healthcheck listening on :{os.environ.get('PORT', '8080')}", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        srv.shutdown()
