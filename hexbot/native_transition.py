"""One-time handoff for services updating through the historical source feed."""
from __future__ import annotations

import errno
import hashlib
import json
import os
import platform
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath

MARKER = "HEXBOT_NATIVE_TRANSITION.json"
MAX_ARCHIVE = 1024 * 1024 * 1024
MAX_UNPACKED = 4 * 1024 * 1024 * 1024
MAX_ENTRIES = 100_000


def _download(url: str, destination: Path, limit: int) -> None:
    with urllib.request.urlopen(url, timeout=120) as response, destination.open("wb") as output:
        redirected = urllib.parse.urlparse(response.url)
        if redirected.scheme != "https" or redirected.netloc != urllib.parse.urlparse(url).netloc:
            raise ValueError("Native download changed origin")
        size = 0
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > limit:
                raise ValueError("Native download exceeds size limit")
            output.write(chunk)


def _extract(archive: Path, destination: Path) -> None:
    total = 0
    with tarfile.open(archive, "r:gz") as bundle:
        for count, member in enumerate(bundle, 1):
            if count > MAX_ENTRIES:
                raise ValueError("Native archive has too many entries")
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or "\\" in member.name:
                raise ValueError("Unsafe native archive path")
            if not member.isdir() and not member.isfile():
                raise ValueError("Native archive links and special files are forbidden")
            total += member.size
            if total > MAX_UNPACKED:
                raise ValueError("Native archive exceeds size limit")
            target = destination.joinpath(*path.parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(member) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output)
                target.chmod(member.mode & 0o777)


def _atomic(path: Path, content: str, mode: int = 0o600) -> None:
    fd, temporary = tempfile.mkstemp(prefix=".hexbot-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            output.write(content)
            os.fchmod(output.fileno(), mode)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        _sync_directory(path.parent)
    finally:
        Path(temporary).unlink(missing_ok=True)


def _sync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        try:
            os.fsync(descriptor)
        except OSError as error:
            if error.errno not in (errno.EINVAL, errno.ENOTSUP):
                raise
    finally:
        os.close(descriptor)


def install(home: Path, version: str, *, download=_download) -> Path:
    """Validate a complete bundle before changing the service's selected executable."""
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?", version):
        raise ValueError("Invalid native version")
    os_name = {"Darwin": "macos", "Linux": "linux"}.get(platform.system())
    arch = {"arm64": "aarch64", "aarch64": "aarch64", "x86_64": "x86_64", "AMD64": "x86_64"}.get(platform.machine())
    if not os_name or not arch:
        raise ValueError("Unsupported native runtime platform")
    target = f"{os_name}-{arch}"
    runtime = home / "runtime"
    native = runtime / "native"
    for directory in (home, runtime, native):
        if directory.is_symlink():
            raise ValueError("Runtime directories cannot be symbolic links")
        directory.mkdir(parents=True, exist_ok=True)
    if (runtime / "native-executable").is_dir():
        raise ValueError("Native executable pointer cannot be a directory")
    base = os.environ.get("HEXBOT_UPDATE_URL", "https://updates.hexbot.app").rstrip("/")
    origin = urllib.parse.urlparse(base)
    if origin.scheme != "https" or not origin.netloc or origin.username or origin.password:
        raise ValueError("Native updates require HTTPS")
    with tempfile.TemporaryDirectory(prefix=".transition-", dir=native) as temporary:
        staging = Path(temporary)
        manifest_path = staging / "manifest.json"
        download(f"{base}/daemon/native/{version}/{target}/manifest.json", manifest_path, 1024 * 1024)
        manifest = json.loads(manifest_path.read_text())
        if not isinstance(manifest, dict) or any(manifest.get(key) != value for key, value in {
            "version": version, "target": target, "format": "tar.gz", "entrypoint": "hexbot"
        }.items()):
            raise ValueError("Native manifest does not match requested runtime")
        url = manifest.get("url", "")
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != "https" or parsed.netloc != origin.netloc:
            raise ValueError("Native archive must use the update server origin")
        archive = staging / "bundle.tar.gz"
        download(url, archive, MAX_ARCHIVE)
        digest = hashlib.sha256()
        with archive.open("rb") as downloaded:
            for chunk in iter(lambda: downloaded.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != manifest.get("sha256"):
            raise ValueError("Native archive checksum mismatch")
        bundle = staging / "bundle"
        bundle.mkdir()
        _extract(archive, bundle)
        executable = bundle / "hexbot"
        checked = subprocess.run([str(executable), "version"], check=True, capture_output=True, text=True, timeout=30)
        if checked.stdout.strip() != version:
            raise ValueError("Native runtime version mismatch")
        destination = native / f"{version}-{staging.name.removeprefix('.transition-')}"
        os.replace(bundle, destination)
        _sync_directory(native)
    executable = destination / "hexbot"
    stable = runtime / "native-executable"
    previous = str(stable.resolve()) if stable.is_file() else None
    _atomic(runtime / "native-current.json", json.dumps({"version": version, "executable": str(executable), "previous": previous}))
    link = runtime / f".native-executable-{destination.name}"
    try:
        link.symlink_to(executable)
        os.replace(link, runtime / "native-executable")
        _sync_directory(runtime)
    finally:
        link.unlink(missing_ok=True)
    # Existing launchd/systemd definitions already point here. Keep that path stable.
    launcher = runtime / "venv/bin/hexbot"
    if launcher.is_file() and not launcher.is_symlink():
        script = ("#!/bin/sh\nset -eu\n"
                  f'exec {shlex.quote(str(runtime / "native-executable"))} "$@"\n')
        _atomic(launcher, script, 0o755)
    _atomic(runtime / "native-transition-pending", "1")
    return executable


def _refuse_running_daemon(home: Path) -> None:
    """The legacy restart uses exec, which closes its listener before this runs.

    A separate invocation must never start native alongside that old process.
    There is no trustworthy legacy pid file, so do not signal a guessed PID.
    """
    state_path = home / "serve-state.json"
    if not state_path.exists():
        return
    state = json.loads(state_path.read_text())
    host = state.get("host", "127.0.0.1")
    host = {"0.0.0.0": "127.0.0.1", "::": "::1"}.get(host, host)
    port = state.get("port")
    if not isinstance(port, int) or isinstance(port, bool) or not 0 < port <= 65535:
        raise ValueError("Cannot verify the previous daemon's port")
    try:
        with socket.create_connection((host, port), timeout=1):
            pass
    except ConnectionRefusedError:
        return
    raise RuntimeError("Stop the existing Hexbot daemon before starting the native daemon")


def _migrate_service(home: Path, user_home: Path | None = None) -> None:
    """Update persistent service definitions; the current restart uses exec."""
    import html
    user_home = user_home or Path.home()
    legacy = str(home / "runtime/venv/bin/hexbot")
    native = str(home / "runtime/native-executable")
    for file, encode in [
        (user_home / "Library/LaunchAgents/app.hexbot.daemon.plist", lambda text: html.escape(text, quote=False).replace('"', "&quot;")),
        (user_home / ".config/systemd/user/hexbot.service", lambda text: text.replace("\\", "\\\\").replace('"', '\\"')),
    ]:
        if not file.is_file():
            continue
        old = file.read_text()
        legacy_entry = (f'<string>{encode(legacy)}</string>' if file.suffix == ".plist"
                        else f'ExecStart="{encode(legacy)}" serve')
        if legacy_entry not in old:
            continue
        updated = old.replace(encode(legacy), encode(native))
        obsolete = encode(str(home / "runtime/venv/bin"))
        pattern = (r'(<key>PATH</key>\s*<string>)([^<]*)(</string>)' if file.suffix == ".plist"
                   else r'(Environment=PATH=")(.*)("$)')
        updated = re.sub(pattern, lambda match: match[1] + ":".join(
            part for part in match[2].split(":") if part and part != obsolete) + match[3],
            updated, flags=re.MULTILINE)
        _atomic(file, updated)
        if file.suffix == ".service":
            subprocess.run(["systemctl", "--user", "daemon-reload"], check=True, timeout=30)


def handoff(argv=None) -> None:
    marker = Path(__file__).resolve().parent.parent / MARKER
    if not marker.is_file():
        return
    version = json.loads(marker.read_text())["version"]
    home = Path(os.environ["HEXBOT_HOME"]).expanduser().resolve()
    pointer = home / "runtime/native-current.json"
    executable = None
    try:
        selected = json.loads(pointer.read_text())
        if not isinstance(selected, dict) or not isinstance(selected.get("executable"), str):
            raise ValueError("Invalid native runtime pointer")
        candidate = Path(selected["executable"])
        if selected["version"] == version and candidate.resolve().is_relative_to(home / "runtime/native") and candidate.is_file():
            executable = candidate
    except (OSError, KeyError, ValueError):
        pass
    if executable is None:
        executable = install(home, version)
    arguments = sys.argv[1:] if argv is None else argv
    if arguments and arguments[0] == "serve":
        _refuse_running_daemon(home)
        _migrate_service(home)
    # Replace this process, never spawn native while the old daemon is alive.
    os.execv(str(executable), [str(executable), *arguments])
