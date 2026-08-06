# Test fixture: boot a real JATA Qi gateway (CLI serve) as a subprocess.

import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SERVE_JS = REPO_ROOT / "packages" / "cli" / "dist" / "src" / "index.js"


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_for_health(base_url: str, timeout: float = 60.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(base_url + "/health", timeout=2) as resp:
                if resp.status == 200:
                    return
        except Exception:
            time.sleep(0.5)
    raise RuntimeError(f"gateway did not become healthy at {base_url}")


def seed_admin(base_url: str) -> None:
    """Register the bootstrap admin (registration is public on a fresh server)."""
    req = urllib.request.Request(
        base_url + "/auth/register",
        data=b'{"username":"admin","password":"admin","roles":["admin"]}',
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=5)
    except urllib.error.HTTPError:
        pass  # already registered


class GatewayServer:
    """Context manager running `jataqi serve` for the test suite."""

    def __init__(self, port: int | None = None):
        self.port = port or free_port()
        self.base_url = f"http://127.0.0.1:{self.port}"
        self.proc: subprocess.Popen | None = None

    def start(self) -> "GatewayServer":
        env = dict(os.environ)
        env.setdefault("JATAQI_PORT", str(self.port))
        # Boot logs go to a file (never a pipe — a full pipe would stall the
        # server before it binds the port).
        log = open(f"/tmp/jataqi-serve-{self.port}.log", "w")
        self.proc = subprocess.Popen(
            ["node", str(SERVE_JS), "serve", str(self.port)],
            cwd=str(REPO_ROOT),
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        wait_for_health(self.base_url)
        seed_admin(self.base_url)
        return self

    def stop(self) -> None:
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
            self.proc = None

    def __enter__(self) -> "GatewayServer":
        return self.start()

    def __exit__(self, *exc) -> None:
        self.stop()
