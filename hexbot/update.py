"""Daemon updates asked for by a client (docs/channels.md, "Updating a daemon").

A client that runs a newer Hexbot than the daemon it talks to offers to update
the daemon without a shell on its machine. How the daemon updates depends on
who runs it, read from ``HEXBOT_SUPERVISOR``:

- ``desktop``: the Hexbot app on this machine spawned the daemon. The daemon
  prints ``HEXBOT_UPDATE_REQUESTED version=<v>`` on stdout; the app reads
  it, updates itself, and relaunches with a new daemon
  (``apps/desktop/src/main/remote-update.ts``). The app writes its progress
  to ``runtime/update-status.json`` and ``status()`` reads it back.
- ``service``: launchd or systemd runs the daemon. The daemon downloads the
  source of the requested version from the update server, syncs the runtime
  venv the way the app's bootstrap does, checks the result, and restarts
  itself.
- unset: a checkout or a hand-started daemon. Nothing can be done remotely.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import threading
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from hexbot.errors import HexbotError
from hexbot.home import hexbot_home

logger = logging.getLogger(__name__)

CAPABILITIES = ("desktop", "service")
DEFAULT_UPDATE_URL = "https://updates.hexbot.app"
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$")
ACTIVE = {"requested", "checking", "downloading", "installing", "restarting"}
STATUS_FILE = "update-status.json"

_lock = threading.Lock()
_state: dict = {"status": "idle", "requested": None, "version": None, "message": None,
                "percent": None, "at": None}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def capability() -> str | None:
    value = os.environ.get("HEXBOT_SUPERVISOR")
    return value if value in CAPABILITIES else None


def runtime_dir() -> Path:
    return hexbot_home() / "runtime"


def source_dir(version: str) -> Path:
    return runtime_dir() / "src" / version


def _set(**fields) -> dict:
    with _lock:
        _state.update(fields, at=_now())
        return dict(_state)


def request(version: str) -> dict:
    """Start updating this daemon to ``version``; returns at once."""
    from hexbot import __version__

    if not isinstance(version, str) or not VERSION_RE.match(version):
        raise HexbotError(4200, "invalid parameter: version")
    method = capability()
    if method is None:
        raise HexbotError(4210, "This daemon cannot update itself. Update Hexbot on its machine.")
    if version == __version__:
        raise HexbotError(4212, f"The daemon already runs {version}")
    with _lock:
        if _state["status"] in ACTIVE:
            raise HexbotError(4211, "A daemon update is already in progress")
        _state.update(status="requested", requested=version, version=None, message=None,
                      percent=None, at=_now())
    if method == "desktop":
        # The app that spawned us watches stdout (backend/manager.ts).
        (runtime_dir() / STATUS_FILE).unlink(missing_ok=True)
        print(f"HEXBOT_UPDATE_REQUESTED version={version}", flush=True)
    else:
        threading.Thread(target=_service_update, args=(version,), name="hexbot-update",
                         daemon=True).start()
    return {"accepted": True, "method": method, "version": version}


def status() -> dict:
    """The update in progress, if any, plus how this daemon can update."""
    with _lock:
        current = dict(_state)
    if capability() == "desktop" and current["status"] != "idle":
        current.update(_app_status(current["at"]))
    return {"capability": capability(), **current}


def _app_status(since: str | None) -> dict:
    """What the app wrote about the update it is running for us."""
    try:
        raw = json.loads((runtime_dir() / STATUS_FILE).read_text())
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict) or not isinstance(raw.get("status"), str):
        return {}
    if since and _before(raw.get("at"), since):
        return {}
    return {key: raw.get(key) for key in ("status", "percent", "message", "version", "at")}


def _before(written: object, since: str) -> bool:
    """True when the app's report predates this request (a stale file)."""
    if not isinstance(written, str):
        return False
    try:
        return datetime.fromisoformat(written) < datetime.fromisoformat(since)
    except ValueError:
        return False


def _download(url: str, dest: Path, progress) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=60) as response, dest.open("wb") as out:
        if response.status != 200:
            raise RuntimeError(f"download failed ({response.status}): {url}")
        total = int(response.headers.get("content-length") or 0)
        received = 0
        while True:
            chunk = response.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
            received += len(chunk)
            if total:
                progress(min(100, received * 100 // total))


def _extract(archive: Path, destination: Path) -> None:
    """Unpack ``hexbot-src/`` from the archive into ``destination``."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as tar, tempfile.TemporaryDirectory(dir=destination.parent) as tmp:
        for member in tar.getmembers():
            if member.name != "hexbot-src" and not member.name.startswith("hexbot-src/"):
                raise RuntimeError(f"unexpected entry in archive: {member.name}")
        tar.extractall(tmp, filter="data")
        shutil.rmtree(destination, ignore_errors=True)
        shutil.move(os.path.join(tmp, "hexbot-src"), destination)


def _uv() -> str:
    return shutil.which("uv") or str(hexbot_home() / "bin" / "uv")


def _service_update(version: str, *, download=_download, run=subprocess.run,
                    restart=None) -> dict:
    """Fetch, install, and restart. Runs on its own thread; never raises."""
    home = hexbot_home()
    venv = runtime_dir() / "venv"
    source = source_dir(version)
    try:
        if not (source / "pyproject.toml").is_file():
            _set(status="downloading", percent=0)
            base = os.environ.get("HEXBOT_UPDATE_URL", DEFAULT_UPDATE_URL).rstrip("/")
            archive = runtime_dir() / f"hexbot-src-{version}.tar.gz"
            archive.parent.mkdir(parents=True, exist_ok=True)
            download(f"{base}/daemon/hexbot-src-{version}.tar.gz", archive,
                     lambda percent: _set(percent=percent))
            _extract(archive, source)
            archive.unlink(missing_ok=True)
        _set(status="installing", percent=None)
        env = {**os.environ, "UV_PROJECT_ENVIRONMENT": str(venv),
               "UV_PYTHON": str(venv / "bin" / "python"),
               "UV_PYTHON_INSTALL_DIR": str(home / "python"), "VIRTUAL_ENV": str(venv)}
        sync = run([_uv(), "sync", "--extra", "all", "--locked"], cwd=str(source), env=env,
                   capture_output=True, text=True)
        if sync.returncode != 0:
            raise RuntimeError(f"uv sync failed: {(sync.stderr or '').strip()[-500:]}")
        check = run([str(venv / "bin" / "hexbot"), "version"], env=env, capture_output=True,
                    text=True)
        installed = (check.stdout or "").strip()
        if check.returncode != 0 or installed != version:
            raise RuntimeError(f"installed runtime reports {installed or 'nothing'}, "
                               f"expected {version}")
        _set(status="restarting", version=version)
        if restart is None:
            from hexbot.serve import request_restart as restart
        restart()
        return dict(_state)
    except Exception as exc:  # noqa: BLE001 - reported to the client
        logger.exception("daemon update to %s failed", version)
        return _set(status="failed", message=str(exc), percent=None)
