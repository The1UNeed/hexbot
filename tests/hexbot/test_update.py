"""Daemon self-update requested by a newer client (hexbot/update.py)."""

import io
import json
import tarfile
from types import SimpleNamespace

import pytest

from hexbot import update
from hexbot.errors import HexbotError


@pytest.fixture(autouse=True)
def reset_state():
    with update._lock:
        update._state.update(status="idle", requested=None, version=None, message=None,
                             percent=None, at=None)
    yield


def test_capability_comes_from_the_supervisor(monkeypatch):
    monkeypatch.delenv("HEXBOT_SUPERVISOR", raising=False)
    assert update.capability() is None
    monkeypatch.setenv("HEXBOT_SUPERVISOR", "desktop")
    assert update.capability() == "desktop"
    monkeypatch.setenv("HEXBOT_SUPERVISOR", "service")
    assert update.capability() == "service"
    monkeypatch.setenv("HEXBOT_SUPERVISOR", "other")
    assert update.capability() is None
    assert update.status()["status"] == "idle"


def test_request_refuses_what_it_cannot_do(monkeypatch):
    monkeypatch.delenv("HEXBOT_SUPERVISOR", raising=False)
    with pytest.raises(HexbotError) as refused:
        update.request("0.1.6")
    assert refused.value.code == 4210
    monkeypatch.setenv("HEXBOT_SUPERVISOR", "desktop")
    with pytest.raises(HexbotError) as invalid:
        update.request("../etc")
    assert invalid.value.code == 4200
    monkeypatch.setattr("hexbot.__version__", "0.1.6")
    with pytest.raises(HexbotError) as same:
        update.request("0.1.6")
    assert same.value.code == 4212


def test_desktop_request_hands_off_to_the_app(monkeypatch, capsys, isolated_home):
    monkeypatch.setenv("HEXBOT_SUPERVISOR", "desktop")
    result = update.request("0.1.5-nightly.20260916.9")
    assert result == {"accepted": True, "method": "desktop", "version": "0.1.5-nightly.20260916.9"}
    assert "HEXBOT_UPDATE_REQUESTED version=0.1.5-nightly.20260916.9" in capsys.readouterr().out
    with pytest.raises(HexbotError) as busy:
        update.request("0.1.5-nightly.20260916.9")
    assert busy.value.code == 4211
    assert update.status()["status"] == "requested"
    # The app reports through runtime/update-status.json.
    runtime = isolated_home / "runtime"
    runtime.mkdir()
    (runtime / "update-status.json").write_text(json.dumps({
        "status": "downloading", "percent": 40, "message": None,
        "version": "0.1.5-nightly.20260916.9", "at": "2999-01-01T00:00:00+00:00"}))
    assert update.status() == {
        "capability": "desktop", "status": "downloading", "percent": 40, "message": None,
        "version": "0.1.5-nightly.20260916.9", "requested": "0.1.5-nightly.20260916.9",
        "at": "2999-01-01T00:00:00+00:00"}
    # A stale file from an earlier request is ignored.
    (runtime / "update-status.json").write_text(json.dumps({
        "status": "failed", "at": "2000-01-01T00:00:00+00:00"}))
    assert update.status()["status"] == "requested"


def _archive(version):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for name, text in (("hexbot-src/pyproject.toml", "[project]\n"),
                           ("hexbot-src/hexbot/__init__.py", f'__version__ = "{version}"\n')):
            data = text.encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def test_service_update_downloads_syncs_checks_and_restarts(monkeypatch, isolated_home):
    monkeypatch.setenv("HEXBOT_SUPERVISOR", "service")
    monkeypatch.setenv("HEXBOT_UPDATE_URL", "https://updates.example/")
    version = "0.1.5-nightly.20260916.9"
    downloads, commands, restarted = [], [], []

    def download(url, dest, progress):
        downloads.append(url)
        dest.write_bytes(_archive(version))
        progress(100)

    def run(command, **kwargs):
        commands.append((command, kwargs.get("cwd")))
        stdout = f"{version}\n" if command[-1] == "version" else ""
        return SimpleNamespace(returncode=0, stdout=stdout, stderr="")

    state = update._service_update(version, download=download, run=run,
                                   restart=lambda: restarted.append(True))
    assert downloads == [f"https://updates.example/daemon/hexbot-src-{version}.tar.gz"]
    source = isolated_home / "runtime" / "src" / version
    assert (source / "hexbot" / "__init__.py").read_text() == f'__version__ = "{version}"\n'
    assert not (isolated_home / "runtime" / f"hexbot-src-{version}.tar.gz").exists()
    assert commands[0][0][1:] == ["sync", "--extra", "all", "--locked"]
    assert commands[0][1] == str(source)
    assert commands[1][0][-1] == "version"
    assert restarted == [True]
    assert state["status"] == "restarting" and state["version"] == version

    # A source the app already staged is reused without a download.
    downloads.clear()
    update._service_update(version, download=download, run=run, restart=lambda: None)
    assert downloads == []


def test_service_update_reports_failures(monkeypatch, isolated_home):
    monkeypatch.setenv("HEXBOT_SUPERVISOR", "service")
    version = "0.1.6"

    def download(url, dest, progress):
        dest.write_bytes(_archive(version))

    def run(command, **kwargs):
        return SimpleNamespace(returncode=1, stdout="", stderr="resolution failed")

    state = update._service_update(version, download=download, run=run, restart=lambda: None)
    assert state["status"] == "failed"
    assert "resolution failed" in state["message"]
    assert update.status()["status"] == "failed"


def test_archive_entries_must_live_under_the_source_root(isolated_home, tmp_path):
    archive = tmp_path / "bad.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        info = tarfile.TarInfo("elsewhere/x")
        info.size = 0
        tar.addfile(info, io.BytesIO(b""))
    destination = isolated_home / "runtime" / "src" / "0.1.6"
    destination.parent.mkdir(parents=True)
    with pytest.raises(RuntimeError, match="unexpected entry"):
        update._extract(archive, destination)
