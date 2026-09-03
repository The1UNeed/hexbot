"""Hex Connect registration, tunnel supervision, and daemon heartbeat."""

from __future__ import annotations

import json
import logging
import os
import platform
import subprocess
import threading
import time
import urllib.request
from dataclasses import asdict, dataclass, fields
from pathlib import Path

import httpx
from ruamel.yaml import YAML

from hexbot.errors import HexbotError
from hexbot.home import hexbot_home

logger = logging.getLogger(__name__)
DEFAULT_API_BASE = "https://hexbot.app"
REGISTER_TIMEOUT = 10 * 60
HEARTBEAT_INTERVAL = 5 * 60


@dataclass
class ConnectConfig:
    api_base: str = DEFAULT_API_BASE
    daemon_id: str = ""
    daemon_token: str = ""
    slug: str = ""
    tunnel_hostname: str = ""
    tunnel_token: str = ""
    registered_at: float | None = None
    jwks_url: str = ""

    def __post_init__(self) -> None:
        self.api_base = self.api_base.rstrip("/")
        if not self.jwks_url:
            self.jwks_url = f"{self.api_base}/.well-known/jwks.json"

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
            return cls(**{key: value for key, value in raw.items() if key in allowed})
        except (OSError, ValueError, TypeError):
            logger.warning("could not read %s", path, exc_info=True)
            return None

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
    def __init__(self, api_base: str = DEFAULT_API_BASE, http=None):
        self.api_base = api_base.rstrip("/")
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

    def heartbeat(self, daemon_id: str, daemon_token: str, port: int) -> dict:
        return self._json("POST", f"/api/daemons/{daemon_id}/heartbeat",
                          headers={"Authorization": f"Bearer {daemon_token}"},
                          json={"port": port})

    def jwks(self) -> dict:
        return self._json("GET", "/.well-known/jwks.json")


def save_registration(result: dict, api_base: str) -> ConnectConfig:
    required = ("daemon_id", "daemon_token", "slug", "tunnel_hostname", "tunnel_token")
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
            state = result.get("status", "approved" if result.get("daemon_token") else "pending")
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


CLOUDFLARED_VERSION = "2026.8.0"
CLOUDFLARED_URLS = {
    ("darwin", "arm64"): f"https://github.com/cloudflare/cloudflared/releases/download/{CLOUDFLARED_VERSION}/cloudflared-darwin-arm64.tgz",
    ("darwin", "x86_64"): f"https://github.com/cloudflare/cloudflared/releases/download/{CLOUDFLARED_VERSION}/cloudflared-darwin-amd64.tgz",
    ("linux", "x86_64"): f"https://github.com/cloudflare/cloudflared/releases/download/{CLOUDFLARED_VERSION}/cloudflared-linux-amd64",
}


def _download(url: str, destination: Path) -> None:
    urllib.request.urlretrieve(url, destination)


class Tunnel:
    def __init__(self, config: ConnectConfig | None = None, *, spawn=None,
                 download=None, sleep=None):
        self.config = config or ConnectConfig.load()
        self.spawn = spawn or subprocess.Popen
        self.download = download or _download
        self.sleep = sleep
        self.process = None
        self.thread: threading.Thread | None = None
        self._stop = threading.Event()

    def ensure_cloudflared(self) -> Path:
        binary = hexbot_home() / "bin" / "cloudflared"
        if binary.is_file():
            return binary
        key = (platform.system().lower(), platform.machine().lower())
        aliases = {"amd64": "x86_64", "x64": "x86_64", "aarch64": "arm64"}
        key = (key[0], aliases.get(key[1], key[1]))
        url = CLOUDFLARED_URLS.get(key)
        if url is None:
            raise HexbotError(5242, f"cloudflared is unsupported on {key[0]} {key[1]}")
        binary.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        downloaded = binary.with_suffix(".download")
        self.download(url, downloaded)
        if url.endswith(".tgz"):
            import tarfile
            with tarfile.open(downloaded) as archive:
                member = next(item for item in archive.getmembers()
                              if Path(item.name).name == "cloudflared")
                member.name = "cloudflared"
                archive.extract(member, binary.parent, filter="data")
            downloaded.unlink()
        else:
            downloaded.replace(binary)
        binary.chmod(0o700)
        return binary

    def start(self, port: int) -> None:
        if not self.config or not self.config.tunnel_token or (self.thread and self.thread.is_alive()):
            return
        binary = self.ensure_cloudflared()
        log_path = hexbot_home() / "logs" / "cloudflared.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        self._stop.clear()
        log = log_path.open("ab")
        command = [str(binary), "tunnel", "run", "--token", self.config.tunnel_token]
        self.process = self.spawn(command, stdout=log, stderr=log)

        def supervise():
            backoff = 1
            try:
                while not self._stop.is_set():
                    try:
                        self.process.wait()
                    except Exception:
                        logger.debug("cloudflared failed", exc_info=True)
                    finally:
                        self.process = None
                    if self.sleep is None:
                        if self._stop.wait(backoff):
                            break
                    else:
                        self.sleep(backoff)
                        if self._stop.is_set():
                            break
                    backoff = min(backoff * 2, 16)
                    if not self._stop.is_set():
                        try:
                            self.process = self.spawn(command, stdout=log, stderr=log)
                        except Exception:
                            logger.debug("could not restart cloudflared", exc_info=True)
            finally:
                log.close()

        self.thread = threading.Thread(target=supervise, name="hexbot-cloudflared", daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self._stop.set()
        process = self.process
        if process is not None and process.poll() is None:
            process.terminate()
        if self.thread and self.thread is not threading.current_thread():
            self.thread.join(timeout=5)

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


def start_daemon(port: int, *, client=None, tunnel=None) -> bool:
    global _tunnel, _heartbeat_stop, _heartbeat_thread, _last_heartbeat_at, _last_error
    config = ConnectConfig.load()
    if config is None or not config.daemon_id:
        return False
    apply_public_url(config.tunnel_hostname)
    _tunnel = tunnel or Tunnel(config)
    _tunnel.start(port)
    api = client or ConnectClient(config.api_base)
    _heartbeat_stop = threading.Event()

    def heartbeat_loop():
        global _last_heartbeat_at, _last_error
        while not _heartbeat_stop.is_set():
            try:
                api.heartbeat(config.daemon_id, config.daemon_token, port)
                _last_heartbeat_at, _last_error = time.time(), None
            except Exception as exc:
                _last_error = str(exc)
                logger.debug("Connect heartbeat failed", exc_info=True)
            if _heartbeat_stop.wait(HEARTBEAT_INTERVAL):
                break

    _heartbeat_thread = threading.Thread(target=heartbeat_loop, name="hexbot-heartbeat", daemon=True)
    _heartbeat_thread.start()
    return True


def disconnect() -> dict:
    global _tunnel, _heartbeat_stop, _heartbeat_thread
    if _heartbeat_stop:
        _heartbeat_stop.set()
    if _tunnel:
        _tunnel.stop()
    if _heartbeat_thread and _heartbeat_thread is not threading.current_thread():
        _heartbeat_thread.join(timeout=5)
    _tunnel = None
    _heartbeat_thread = None
    ConnectConfig.clear()
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


def status() -> dict:
    config = ConnectConfig.load()
    return {"registered": bool(config and config.daemon_id),
            "daemon_id": config.daemon_id if config else None,
            "slug": config.slug if config else None,
            "tunnel_hostname": config.tunnel_hostname if config else None,
            "tunnel_running": bool(_tunnel and _tunnel.running),
            "last_heartbeat_at": _last_heartbeat_at, "last_error": _last_error}
