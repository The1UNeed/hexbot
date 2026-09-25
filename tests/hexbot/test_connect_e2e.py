"""Hexbot Connect end to end on one machine: a real Connect service (Next.js,
in-memory store, fake tunnels, DEV_USER_ID auth), a real daemon, and the same
HTTP calls the CLI, the web client, and the desktop app make.

Opt in with ``HEXBOT_CONNECT_E2E=1``; it needs ``pnpm install`` and the venv.
The only piece not exercised is Cloudflare itself: the grant names the fake
tunnel hostname, so the client-to-daemon leg goes to the daemon's loopback port
instead (in production the tunnel forwards to that same port).
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
from pathlib import Path
from html.parser import HTMLParser

import httpx
import pytest

pytestmark = pytest.mark.skipif(os.environ.get("HEXBOT_CONNECT_E2E") != "1",
                                reason="set HEXBOT_CONNECT_E2E=1 to run the live Connect flow")

ROOT = Path(__file__).resolve().parents[2]


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_for(url: str, timeout: float = 120) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if httpx.get(url, timeout=5).status_code < 500:
                return
        except Exception:
            pass
        time.sleep(0.5)
    raise AssertionError(f"{url} did not come up")


def stop(process: subprocess.Popen | None) -> None:
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(10)
        except subprocess.TimeoutExpired:
            process.kill()


@pytest.fixture(scope="module")
def connect_service(tmp_path_factory):
    port = free_port()
    sandbox = tmp_path_factory.mktemp("connect")
    source = sandbox / "app"
    shutil.copytree(ROOT / "apps/connect", source,
                    ignore=shutil.ignore_patterns(".env*", ".next", "node_modules"))
    # pnpm keeps each workspace package's dependencies under its own node_modules.
    (source / "node_modules").symlink_to(ROOT / "apps/connect/node_modules", target_is_directory=True)
    log = (sandbox / "next.log").open("wb")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("NEXT_PUBLIC_CLERK", "CLERK", "DATABASE_URL", "CF_"))}
    env.update({"DEV_USER_ID": "e2e-user", "CONNECT_BASE_URL": f"http://127.0.0.1:{port}",
                "CONNECT_DOMAIN": "hexbot.test", "CONNECT_INGRESS_PORT": "9119"})
    process = subprocess.Popen(["node", str(ROOT / "apps/connect/node_modules/next/dist/bin/next"), "dev", "--webpack",
                                "-p", str(port), "-H", "127.0.0.1"],
                               cwd=source, env=env, stdout=log, stderr=log)
    try:
        wait_for(f"http://127.0.0.1:{port}/api/health")
        yield f"http://127.0.0.1:{port}"
    finally:
        stop(process)
        log.close()


@pytest.fixture(scope="module")
def daemon_home(tmp_path_factory):
    home = tmp_path_factory.mktemp("hexbot-home")
    binary = home / "bin" / "cloudflared"
    binary.parent.mkdir(mode=0o700)
    binary.write_text("#!/bin/sh\nexec sleep 3600\n")  # stands in for the tunnel process
    binary.chmod(0o700)
    return home


def daemon_env(home: Path, connect_url: str) -> dict:
    env = {k: v for k, v in os.environ.items() if k not in {"HEXBOT_HOME", "HERMES_HOME"}}
    env.update({"HEXBOT_HOME": str(home), "HERMES_HOME": str(home), "HEXBOT_CONNECT_URL": connect_url,
                "HEXBOT_WORKSPACE": str(home / "workspace"), "PYTHONUNBUFFERED": "1"})
    return env


def register_with_cli(home: Path, connect_url: str) -> tuple[str, dict]:
    """Run `hexbot connect`, approve the printed code as the signed-in user, return the code and the approval."""
    process = subprocess.Popen([str(ROOT / "venv/bin/hexbot"), "connect"], cwd=ROOT, env=daemon_env(home, connect_url),
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    lines: list[str] = []
    seen = threading.Event()

    def pump():
        for line in process.stdout:
            lines.append(line.rstrip())
            if line.startswith("Code:"):
                seen.set()

    threading.Thread(target=pump, daemon=True).start()
    assert seen.wait(60), lines
    code = next(line.split(":", 1)[1].strip() for line in lines if line.startswith("Code:"))
    verify = next(line.split(":", 1)[1].strip() for line in lines if line.startswith("Open:"))
    assert verify == f"{connect_url}/connect/approve?code={urllib.parse.quote(code)}"
    approved = httpx.post(f"{connect_url}/api/register/approve", json={"user_code": code.lower()}, timeout=30)
    assert approved.status_code == 200, approved.text
    assert process.wait(60) == 0, lines
    return code, approved.json()


def sign_in_client(connect_url: str, device: str) -> str:
    """Submit the explicit authorization form, including React's progressive-enhancement fields."""
    page = httpx.get(f"{connect_url}/connect/authorize", params={"state": "nonce-1", "device": device}, timeout=60)
    assert page.status_code == 200

    class FormInputs(HTMLParser):
        def __init__(self):
            super().__init__()
            self.fields = []

        def handle_starttag(self, tag, attrs):
            values = dict(attrs)
            if tag == "input" and values.get("name"):
                self.fields.append((values["name"], (None, values.get("value", ""))))

    form = FormInputs()
    form.feed(page.text)
    assert not re.search(r'href="hexbot://', page.text)
    authorized = httpx.post(str(page.url), files=form.fields, headers={"Origin": connect_url}, timeout=60)
    assert authorized.status_code == 200, authorized.text[:500]
    match = re.search(r'href="hexbot://connect\?state=nonce-1#session=([^"]+)"', authorized.text)
    assert match, authorized.text[:500]
    token = urllib.parse.unquote(match.group(1))
    auth = {"Authorization": f"Bearer {token}"}
    sessions = httpx.get(f"{connect_url}/api/me", headers=auth).json()["sessions"]
    # Reloading the landing page must not mint another client session.
    assert httpx.get(str(page.url), timeout=60).status_code == 200
    reloaded = httpx.get(f"{connect_url}/api/me", headers=auth).json()["sessions"]
    assert {item["id"] for item in reloaded} == {item["id"] for item in sessions}
    return token


async def rpc_session(port: int, ticket: str):
    import websockets

    async with websockets.connect(f"ws://127.0.0.1:{port}/api/ws?ticket={ticket}", max_size=None) as ws:
        results = {}
        rid = 0
        for method in ("hexbot.info", "hexbot.devices.list", "hexbot.connect.status"):
            rid += 1
            await ws.send(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": {}}))
            while True:
                frame = json.loads(await ws.recv())
                if frame.get("id") == rid:
                    assert "error" not in frame, frame
                    results[method] = frame["result"]
                    break
        return results


def test_connect_end_to_end(connect_service, daemon_home, tmp_path):
    connect_url = connect_service
    health = httpx.get(f"{connect_url}/api/health").json()
    assert health == {"ok": True, "ready": False, "store": "memory", "tunnels": "fake", "auth": "dev",
                      "signing": "ephemeral", "domain": "hexbot.test"}

    # Cross-origin access from the desktop app and LAN browsers.
    preflight = httpx.options(f"{connect_url}/api/daemons", headers={"Origin": "hexbot-app://app",
                              "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization"})
    assert preflight.status_code == 204 and preflight.headers["access-control-allow-origin"] == "*"

    # 1. Daemon registration through the CLI, approved in the browser.
    code, approved = register_with_cli(daemon_home, connect_url)
    assert re.fullmatch(r"[A-Z2-9]{4}-[A-Z2-9]{4}", code)
    config = json.loads((daemon_home / "connect.json").read_text())
    assert config["api_base"] == connect_url and config["daemon_id"] == approved["daemon_id"]
    assert config["tunnel_hostname"] == approved["hostname"]
    assert re.fullmatch(r"[a-z]+-[a-z]+-\d+\.hexbot\.test", config["tunnel_hostname"])
    assert f"public_url: https://{config['tunnel_hostname']}" in (daemon_home / "config.yaml").read_text()
    again = httpx.post(f"{connect_url}/api/register/approve", json={"user_code": code})
    assert again.status_code == 409

    # 2. The daemon serves, starts its tunnel, and heartbeats with its real port.
    port = free_port()
    log = (tmp_path / "daemon.log").open("wb")
    daemon = subprocess.Popen([str(ROOT / "venv/bin/hexbot"), "serve", "--lan", "--port", str(port)], cwd=ROOT,
                              env=daemon_env(daemon_home, connect_url), stdout=log, stderr=log)
    try:
        wait_for(f"http://127.0.0.1:{port}/api/auth/providers")

        # 3. Client sign-in, daemon list, grant.
        session = sign_in_client(connect_url, "Laptop")
        assert session.startswith("hxc_")
        auth = {"Authorization": f"Bearer {session}"}
        me = httpx.get(f"{connect_url}/api/me", headers=auth).json()
        assert me["session"]["device_name"] == "Laptop"
        deadline = time.monotonic() + 30
        while True:
            daemons = httpx.get(f"{connect_url}/api/daemons", headers=auth).json()["daemons"]
            if daemons and daemons[0]["online"]:
                break
            assert time.monotonic() < deadline, daemons
            time.sleep(0.5)
        assert daemons[0]["tunnel_hostname"] == config["tunnel_hostname"]
        granted = httpx.post(f"{connect_url}/api/daemons/{daemons[0]['id']}/grant", headers=auth).json()
        # With the fake tunnel provider the grant names the daemon's loopback port (the tunnel target).
        assert granted["daemon"] == {"id": daemons[0]["id"], "name": daemons[0]["name"],
                                     "host": "127.0.0.1", "port": port, "tls": False}
        assert httpx.post(f"{connect_url}/api/daemons/{daemons[0]['id']}/grant").status_code == 401

        # 4. The daemon exchanges the grant for a device token (the tunnel would forward here).
        base = f"http://127.0.0.1:{port}"
        login = httpx.post(f"{base}/auth/password-login", json={"provider": "hexbot", "username": "Laptop",
                                                                 "password": f"cg_{granted['grant']}"})
        assert login.status_code == 200, login.text
        token = login.cookies["hermes_session_at"]
        assert token.startswith("hxb_")
        tampered = granted["grant"][:-4] + "AAAA"
        assert httpx.post(f"{base}/auth/password-login", json={"provider": "hexbot", "username": "Laptop",
                                                                "password": f"cg_{tampered}"}).status_code == 401
        # A grant logs in once.
        assert httpx.post(f"{base}/auth/password-login", json={"provider": "hexbot", "username": "Laptop",
                                                                "password": f"cg_{granted['grant']}"}).status_code == 401

        # 4b. Browser sign-in: the daemon's login page offers Connect, the round trip ends in a cookie session.
        login_page = httpx.get(f"{base}/login")
        assert 'href="/auth/login?provider=connect' in login_page.text
        with httpx.Client(base_url=base, follow_redirects=False) as browser:
            started = browser.get("/auth/login", params={"provider": "connect", "next": "/"})
            assert started.status_code == 302, started.text
            to_connect = httpx.URL(started.headers["location"])
            assert f"{to_connect.scheme}://{to_connect.host}:{to_connect.port}" == connect_url
            query = dict(to_connect.params)
            # The daemon names its public address; the tunnel would forward that callback to the loopback port.
            public = f"https://{config['tunnel_hostname']}"
            assert query["daemon"] == approved["daemon_id"] and query["redirect_uri"] == f"{public}/auth/callback"
            back = httpx.get(str(to_connect), headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                             "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"},
                             follow_redirects=False, timeout=60)
            assert back.status_code in {302, 307}, back.text[:500]
            callback = httpx.URL(back.headers["location"])
            assert str(callback).startswith(f"{public}/auth/callback?") and callback.params["state"] == query["state"]
            finished = browser.get(callback.path, params=dict(callback.params))
            assert finished.status_code == 302 and finished.headers["location"] == "/", finished.text[:500]
            assert finished.cookies["hermes_session_at"].startswith("hxb_")
            # Replaying the callback fails: the daemon's state cookie is gone and the code is spent.
            assert browser.get(callback.path, params=dict(callback.params)).status_code == 400
            whoami = httpx.get(f"{base}/api/auth/me", cookies=finished.cookies)
            assert whoami.status_code == 200 and whoami.json().get("display_name") == "Chrome on macOS", whoami.text

        ticket = httpx.post(f"{base}/api/auth/ws-ticket", headers={"Authorization": f"Bearer {token}"}).json()["ticket"]
        results = asyncio.run(rpc_session(port, ticket))
        assert results["hexbot.info"]["auth_required"] is True
        device = next(item for item in results["hexbot.devices.list"]["devices"] if item["current"])
        assert device["name"] == "Laptop" and device["platform"] == "connect"
        status = results["hexbot.connect.status"]
        assert status["registered"] and status["tunnel_running"] and status["last_error"] is None
        assert status["last_heartbeat_at"] and status["tunnel_hostname"] == config["tunnel_hostname"]

        # 5. Revoking the client session cuts off the Connect API, not the daemon token.
        assert httpx.delete(f"{connect_url}/api/sessions/{me['session']['id']}", headers=auth).status_code == 200
        assert httpx.get(f"{connect_url}/api/daemons", headers=auth).status_code == 401
        assert httpx.post(f"{base}/api/auth/ws-ticket", headers={"Authorization": f"Bearer {token}"}).status_code == 200

        # 6. Disconnecting revokes the registration on both sides.
        status = subprocess.run([str(ROOT / "venv/bin/hexbot"), "connect", "status"], cwd=ROOT, capture_output=True,
                                text=True, env=daemon_env(daemon_home, connect_url), check=True)
        assert json.loads(status.stdout)["registered"] is True
        out = subprocess.run([str(ROOT / "venv/bin/hexbot"), "connect", "disconnect"], cwd=ROOT, capture_output=True,
                             text=True, env=daemon_env(daemon_home, connect_url), check=True)
        assert json.loads(out.stdout)["registered"] is False
        assert not (daemon_home / "connect.json").exists()
        assert "public_url" not in (daemon_home / "config.yaml").read_text()
        second = sign_in_client(connect_url, "Phone")
        assert httpx.get(f"{connect_url}/api/daemons", headers={"Authorization": f"Bearer {second}"}).json() == {"daemons": []}
        assert httpx.post(f"{connect_url}/api/daemons/{approved['daemon_id']}/heartbeat", json={"port": port},
                          headers={"Authorization": f"Bearer {config['daemon_token']}"}).status_code == 401
    finally:
        stop(daemon)
        log.close()
        if os.environ.get("HEXBOT_CONNECT_E2E_LOGS"):
            sys.stderr.write((tmp_path / "daemon.log").read_text(errors="replace"))
