"""Regression tests for the Photon sidecar stale-dependency self-heal.

A `hexbot core update` that bumps the spectrum-ts pin rewrites the sidecar's
``pnpm-lock.yaml`` but never reinstalls ``node_modules``, so the sidecar
spawns against stale deps and dies on every reconnect. ``_sidecar_deps_stale``
detects that skew (lockfile newer than pnpm's install marker, or no marker at
all) so ``_start_sidecar`` can reinstall before spawning.
"""

from __future__ import annotations

import os
import types
from pathlib import Path

import plugins.platforms.photon.adapter as photon_adapter


def _seed(sidecar: Path, *, lock_mtime: float, marker_mtime: float | None) -> None:
    """Create a fake sidecar dir with a lockfile and (optionally) pnpm's marker."""
    (sidecar / "node_modules").mkdir(parents=True)
    lock = sidecar / "pnpm-lock.yaml"
    lock.write_text("lockfileVersion: '9.0'\n", encoding="utf-8")
    os.utime(lock, (lock_mtime, lock_mtime))
    if marker_mtime is not None:
        marker = sidecar / "node_modules" / ".modules.yaml"
        marker.write_text("layoutVersion: 5\n", encoding="utf-8")
        os.utime(marker, (marker_mtime, marker_mtime))


def test_stale_when_lockfile_newer_than_marker(tmp_path, monkeypatch) -> None:
    """The update-rewrites-lockfile-but-skips-install case must reinstall."""
    sidecar = tmp_path / "sidecar"
    _seed(sidecar, lock_mtime=2000.0, marker_mtime=1000.0)
    monkeypatch.setattr(photon_adapter, "_SIDECAR_DIR", sidecar)
    assert photon_adapter._sidecar_deps_stale() is True


def test_fresh_when_marker_newer_than_lockfile(tmp_path, monkeypatch) -> None:
    """A normal install (marker at/after lockfile) must NOT trigger a reinstall."""
    sidecar = tmp_path / "sidecar"
    _seed(sidecar, lock_mtime=1000.0, marker_mtime=2000.0)
    monkeypatch.setattr(photon_adapter, "_SIDECAR_DIR", sidecar)
    assert photon_adapter._sidecar_deps_stale() is False


def test_stale_when_marker_missing(tmp_path, monkeypatch) -> None:
    """pnpm writes the marker on every successful install, so deps without one
    (an aborted install, or a tree another package manager left) are stale."""
    sidecar = tmp_path / "sidecar"
    _seed(sidecar, lock_mtime=2000.0, marker_mtime=None)
    monkeypatch.setattr(photon_adapter, "_SIDECAR_DIR", sidecar)
    assert photon_adapter._sidecar_deps_stale() is True


def test_not_stale_when_lockfile_missing(tmp_path, monkeypatch) -> None:
    """No readable lockfile must fail safe to False, never block start."""
    sidecar = tmp_path / "sidecar"
    _seed(sidecar, lock_mtime=2000.0, marker_mtime=1000.0)
    (sidecar / "pnpm-lock.yaml").unlink()
    monkeypatch.setattr(photon_adapter, "_SIDECAR_DIR", sidecar)
    assert photon_adapter._sidecar_deps_stale() is False


def test_reinstall_runs_frozen_install_outside_the_workspace(tmp_path, monkeypatch) -> None:
    """The sidecar has its own lockfile; pnpm must not resolve it against the
    repository's root workspace."""
    calls = []

    def _run(cmd, **kwargs):
        calls.append((cmd, kwargs["cwd"]))
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(photon_adapter, "_SIDECAR_DIR", tmp_path)
    monkeypatch.setattr(
        "hermes_constants.ensure_hermes_pnpm", lambda: "/managed/pnpm", raising=False
    )
    monkeypatch.setattr(photon_adapter.subprocess, "run", _run)

    photon_adapter._reinstall_sidecar_deps()

    assert calls == [
        (["/managed/pnpm", "install", "--ignore-workspace", "--frozen-lockfile"], str(tmp_path))
    ]


def test_reinstall_without_pnpm_runs_nothing(tmp_path, monkeypatch, caplog) -> None:
    monkeypatch.setattr(photon_adapter, "_SIDECAR_DIR", tmp_path)
    monkeypatch.setattr("hermes_constants.ensure_hermes_pnpm", lambda: None, raising=False)
    monkeypatch.setattr(
        photon_adapter.subprocess,
        "run",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not run")),
    )

    with caplog.at_level("WARNING", logger="plugins.platforms.photon.adapter"):
        photon_adapter._reinstall_sidecar_deps()

    assert any("pnpm is not available" in r.message for r in caplog.records)
