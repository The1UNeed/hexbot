"""Hex Connect registration and daemon heartbeat. The TypeScript sidecar
(connect_agent.mts) runs cloudflared and verifies grants."""

from __future__ import annotations

import json
import logging
import os
import platform
import shutil
import subprocess
import threading
import time
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path

import httpx
from ruamel.yaml import YAML

from hexbot.errors import HexbotError
from hexbot.home import hexbot_home

logger = logging.getLogger(__name__)
DEFAULT_API_BASE = "https://connect.hexbot.app"


def default_api_base() -> str:
    """Connect service URL. HEXBOT_CONNECT_URL points a daemon at a local or self-hosted instance."""
    return (os.environ.get("HEXBOT_CONNECT_URL") or DEFAULT_API_BASE).rstrip("/")
REGISTER_TIMEOUT = 10 * 60
HEARTBEAT_INTERVAL = 5 * 60


@dataclass
class ConnectConfig:
    api_base: str = field(default_factory=default_api_base)
    daemon_id: str = ""
    daemon_token: str = ""
    slug: str = ""
    tunnel_hostname: str = ""
    tunnel_token: str = ""
    registered_at: float | None = None
    # Pinned at registration: grants must name this owner and issuer and be signed by one of these keys.
    owner_id: str = ""
    issuer: str = ""
    keys: list = field(default_factory=list)

    def __post_init__(self) -> None:
        self.api_base = self.api_base.rstrip("/")

    @classmethod
    def path(cls) -> Path:
        return hexbot_home() / "connect.json"

    @classmethod
    def load(cls) -> ConnectConfig | None:
        path = cls.path()
        if not path.exists():
            return None
        try:
            raw = json.loads(path.read_text())
            allowed = {field.name for field in fields(cls)}
            config = cls(**{key: value for key, value in raw.items() if key in allowed})
        except (OSError, ValueError, TypeError):
            logger.warning("could not read %s", path, exc_info=True)
            return None
        if config.daemon_id and not (config.owner_id and config.issuer and config.keys):
            logger.warning("this Hex Connect registration predates owner pinning; run `hexbot connect` again")
            return None
        return config

    def save(self) -> None:
        path = self.path()
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(asdict(self), stream, indent=2)
            stream.write("\n")
        os.chmod(path, 0o600)

    @classmethod
    def clear(cls) -> None:
        try:
            cls.path().unlink()
        except FileNotFoundError:
            pass


class ConnectClient:
    def __init__(self, api_base: str | None = None, http=None):
        self.api_base = (api_base or default_api_base()).rstrip("/")
        self.http = http or httpx.request

    def _json(self, method: str, path: str, **kwargs) -> dict:
        try:
            response = self.http(method, f"{self.api_base}{path}", timeout=15, **kwargs)
            if isinstance(response, dict):
                return response
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, dict):
                raise ValueError("Connect returned a non-object response")
            return data
        except HexbotError:
            raise
        except Exception as exc:
            raise HexbotError(5241, "Connect service unreachable") from exc

    def register_start(self, daemon_name: str, platform: str) -> dict:
        return self._json("POST", "/api/register/start",
                          json={"daemon_name": daemon_name, "platform": platform})

    def register_poll(self, device_code: str) -> dict:
        return self._json("POST", "/api/register/poll", json={"device_code": device_code})

    def revoke(self, daemon_id: str, daemon_token: str) -> dict:
        return self._json("DELETE", f"/api/daemons/{daemon_id}",
                          headers={"Authorization": f"Bearer {daemon_token}"})

    def heartbeat(self, daemon_id: str, daemon_token: str, port: int) -> dict:
        return self._json("POST", f"/api/daemons/{daemon_id}/heartbeat",
                          headers={"Authorization": f"Bearer {daemon_token}"},
                          json={"port": port})

    def exchange_grant(self, daemon_id: str, daemon_token: str, *, code: str,
                       code_verifier: str, redirect_uri: str) -> dict:
        """Trade a browser sign-in code for a grant. A rejected code (4xx) is not an outage."""
        try:
            response = self.http("POST", f"{self.api_base}/api/grants/exchange", timeout=15,
                                 headers={"Authorization": f"Bearer {daemon_token}"},
                                 json={"code": code, "code_verifier": code_verifier,
                                       "redirect_uri": redirect_uri})
            if isinstance(response, dict):
                data = response
            else:
                if response.status_code in {400, 401, 403, 404, 409, 410}:
                    raise HexbotError(4243, "Connect sign-in code rejected")
                response.raise_for_status()
                data = response.json()
        except HexbotError:
            raise
        except Exception as exc:
            raise HexbotError(5241, "Connect service unreachable") from exc
        if not isinstance(data, dict) or not all(
                isinstance(data.get(key), str) for key in ("grant", "device_name")):
            raise HexbotError(5241, "Connect returned an incomplete grant")
        return data


def save_registration(result: dict, api_base: str) -> ConnectConfig:
    required = ("daemon_id", "daemon_token", "slug", "tunnel_hostname", "tunnel_token",
                "owner_id", "issuer", "keys")
    if any(not result.get(key) for key in required):
        raise HexbotError(5241, "Connect returned an incomplete registration")
    config = ConnectConfig(api_base=api_base, registered_at=time.time(),
                           **{key: result[key] for key in required})
    config.save()
    apply_public_url(config.tunnel_hostname)
    return config


def register(daemon_name: str, *, client: ConnectClient, sleep=time.sleep, out=print):
    try:
        started = client.register_start(daemon_name, platform.system().lower())
        out(f"Open: {started['verify_url']}")
        out(f"Code: {started['user_code']}")
        interval = max(float(started.get("interval", 5)), 0)
        deadline = time.monotonic() + REGISTER_TIMEOUT
        while time.monotonic() < deadline:
            result = client.register_poll(started["device_code"])
            state = result["status"]
            if state == "approved":
                return save_registration(result, client.api_base)
            if state == "expired":
                raise HexbotError(4241, "Connect registration expired")
            if state == "denied":
                raise HexbotError(4242, "Connect registration denied")
            sleep(interval)
        raise HexbotError(4241, "Connect registration expired")
    except HexbotError:
        raise
    except Exception as exc:
        raise HexbotError(5241, "Connect service unreachable") from exc


AGENT = Path(__file__).with_name("connect_agent.mts")


def _agent(*args: str) -> tuple[list[str], dict]:
    """Command and environment for the sidecar. The desktop app sets HEXBOT_NODE to its own
    Electron binary, which runs as Node under ELECTRON_RUN_AS_NODE; elsewhere Node 24+ is on PATH."""
    node = os.environ.get("HEXBOT_NODE")
    node = node if node and os.path.exists(node) else shutil.which("node")  # a moved or unmounted app
    if not node:
        raise HexbotError(5243, "Hex Connect needs Node.js 24 or newer")
    env = {**os.environ, "HEXBOT_HOME": str(hexbot_home()), "ELECTRON_RUN_AS_NODE": "1"}
    return [node, str(AGENT), *args], env


def verify_grant(grant: str) -> dict:
    """Claims of a grant the sidecar checked against the pinned owner, issuer, and keys. Raises ValueError."""
    if ConnectConfig.load() is None:
        raise ValueError("Hex Connect is not set up")  # no Node process for a login Connect cannot serve
    command, env = _agent("verify")
    result = subprocess.run(command, env=env, input=grant, capture_output=True, text=True, timeout=20)
    if result.returncode:
        raise ValueError(result.stderr.strip() or "invalid Connect grant")
    return json.loads(result.stdout)


class Tunnel:
    """The sidecar supervising cloudflared. It exits, with cloudflared, when its stdin closes."""

    def __init__(self, config: ConnectConfig | None = None, *, spawn=subprocess.Popen):
        self.config = config or ConnectConfig.load()
        self.spawn = spawn
        self.process = None
        self.stopped = False

    def start(self, port: int) -> None:
        if self.config and self.config.tunnel_token and not self.running and not self.stopped:
            command, env = _agent("tunnel", str(port))
            self.process = self.spawn(command, env=env, stdin=subprocess.PIPE)

    def stop(self) -> None:
        self.stopped = True
        if self.running:
            self.process.stdin.close()
            self.process.wait(timeout=5)

    @property
    def running(self) -> bool:
        return self.process is not None and self.process.poll() is None


def _config_paths() -> list[Path]:
    home = hexbot_home()
    paths = [home / "config.yaml"]
    profiles = home / "profiles"
    if profiles.exists():
        paths.extend(path / "config.yaml" for path in sorted(profiles.iterdir()) if path.is_dir())
    return paths


def apply_public_url(hostname: str | None) -> None:
    yaml = YAML(typ="rt")
    for path in _config_paths():
        try:
            data = yaml.load(path.read_text()) if path.exists() else None
        except Exception:
            logger.warning("could not parse %s; preserving it unchanged", path)
            continue
        data = data if isinstance(data, dict) else {}
        dashboard = data.get("dashboard")
        if hostname:
            if not isinstance(dashboard, dict):
                dashboard = {}
                data["dashboard"] = dashboard
            dashboard["public_url"] = f"https://{hostname}"
        elif isinstance(dashboard, dict):
            dashboard.pop("public_url", None)
            if not dashboard:
                data.pop("dashboard", None)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w") as stream:
            yaml.dump(data, stream)


_tunnel: Tunnel | None = None
_heartbeat_stop: threading.Event | None = None
_heartbeat_thread: threading.Thread | None = None
_last_heartbeat_at: float | None = None
_last_error: str | None = None
_provider = None


def _register_provider() -> None:
    """Offer "Sign in with Hex Connect" on the login page only while registered."""
    global _provider
    try:
        from hermes_cli.dashboard_auth.registry import register_global_provider
        from hexbot.auth_provider import HexConnectProvider
        _provider = HexConnectProvider()
        register_global_provider(_provider)
    except Exception:
        logger.debug("could not register the Connect sign-in provider", exc_info=True)


def _unregister_provider() -> None:
    global _provider
    try:
        from hermes_cli.dashboard_auth.registry import unregister_global_provider
        if _provider is not None:
            unregister_global_provider("connect", _provider)
    except Exception:
        logger.debug("could not unregister the Connect sign-in provider", exc_info=True)
    _provider = None


def start_daemon(port: int, *, client=None, tunnel=None) -> bool:
    global _tunnel, _heartbeat_stop, _heartbeat_thread, _last_heartbeat_at, _last_error
    config = ConnectConfig.load()
    if config is None or not config.daemon_id:
        return False
    _register_provider()
    stop_daemon()  # idempotent: a registration made while serving restarts the workers
    apply_public_url(config.tunnel_hostname)
    tunnel = _tunnel = tunnel or Tunnel(config)
    api = client or ConnectClient(config.api_base)
    stop = _heartbeat_stop = threading.Event()

    def heartbeat_loop():
        global _last_heartbeat_at, _last_error
        while not stop.is_set():
            try:
                tunnel.start(port)  # (re)starts the sidecar if it is not running; a no-op while it runs
            except (HexbotError, OSError) as exc:  # no Node: serve on, LAN pairing and Tailscale do not need it
                logger.warning("Hex Connect tunnel not started: %s", exc)
            try:
                api.heartbeat(config.daemon_id, config.daemon_token, port)
                if stop.is_set():
                    break
                _last_heartbeat_at, _last_error = time.time(), None
            except Exception as exc:
                _last_error = str(exc)
                logger.debug("Connect heartbeat failed", exc_info=True)
            if stop.wait(HEARTBEAT_INTERVAL):
                break

    _heartbeat_thread = threading.Thread(target=heartbeat_loop, name="hexbot-heartbeat", daemon=True)
    _heartbeat_thread.start()
    return True


def disconnect(*, client=None) -> dict:
    """Stop the workers, revoke the registration with Connect (best effort), forget it locally."""
    stop_daemon()
    config = ConnectConfig.load()
    if config and config.daemon_id:
        try:
            (client or ConnectClient(config.api_base)).revoke(config.daemon_id, config.daemon_token)
        except Exception:
            logger.warning("could not revoke the Connect registration remotely", exc_info=True)
    ConnectConfig.clear()
    _unregister_provider()
    apply_public_url(None)
    return status()


def stop_daemon() -> None:
    """Stop Connect workers without forgetting the registration."""
    global _tunnel, _heartbeat_stop, _heartbeat_thread
    if _heartbeat_stop:
        _heartbeat_stop.set()
    if _tunnel:
        _tunnel.stop()
    if _heartbeat_thread and _heartbeat_thread is not threading.current_thread():
        _heartbeat_thread.join(timeout=5)
    _tunnel = None
    _heartbeat_thread = None


def _cloudflared_up() -> bool:
    """Whether the cloudflared the sidecar last started is still alive (it clears the pid when cloudflared exits)."""
    try:
        os.kill(int((hexbot_home() / "cloudflared.pid").read_text()), 0)
        return True
    except (OSError, ValueError):
        return False


def status() -> dict:
    config = ConnectConfig.load()
    return {"registered": bool(config and config.daemon_id),
            "daemon_id": config.daemon_id if config else None,
            "slug": config.slug if config else None,
            "tunnel_hostname": config.tunnel_hostname if config else None,
            "tunnel_running": bool(_tunnel and _tunnel.running and _cloudflared_up()),
            "last_heartbeat_at": _last_heartbeat_at, "last_error": _last_error}
