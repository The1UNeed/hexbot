"""Regression tests for the pnpm output capture + error log persistence fix.

Each test covers a specific failure vector introduced by the Risk 3 solution:

1. _install_sidecar() return code unchanged — still 0 on success, non-zero on failure
2. _install_sidecar() with no pnpm available — still returns 1, nothing is run
3. _PNPM_ERROR_LOG write fails (OSError / read-only fs) — silently handled, no exception
4. _PNPM_ERROR_LOG read fails in check_requirements() — silently handled, returns False
5. pnpm output is empty — log not written, check_requirements() falls back gracefully
6. _PNPM_ERROR_LOG from prior failed run exists when next run succeeds — cleared
7. check_requirements() with no _PNPM_ERROR_LOG — debug log still emitted without error detail
8. The persisted reason starts at pnpm's ERR_PNPM_ line, never at progress output
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path

import pytest

from plugins.platforms.photon import adapter as adapter_mod
from plugins.platforms.photon import cli as cli_mod



def _stub_pnpm(monkeypatch: pytest.MonkeyPatch, returncode: int, output: str = "") -> list:
    """Resolve a managed pnpm and replace the real run; returns the commands run."""
    calls: list = []

    def _run(cmd):
        calls.append(cmd)
        return returncode, output

    monkeypatch.setattr(
        "hermes_constants.ensure_hermes_pnpm", lambda: "/managed/pnpm", raising=False
    )
    monkeypatch.setattr(cli_mod, "_run_pnpm", _run)
    return calls


_NODE_ON_PATH = __import__("shutil").which("node") is not None
_requires_node = pytest.mark.skipif(
    not _NODE_ON_PATH, reason="requires node on PATH"
)


# ---------------------------------------------------------------------------
# 1. Return code contract unchanged
# ---------------------------------------------------------------------------

def test_regression_return_code_zero_on_success(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """_install_sidecar() must still return 0 on pnpm success."""
    _stub_pnpm(monkeypatch, 0, "")
    monkeypatch.setattr(cli_mod, "_PNPM_ERROR_LOG", tmp_path / ".photon-pnpm-error.log")
    assert cli_mod._install_sidecar() == 0


# ---------------------------------------------------------------------------
# 2. OSError on log write — silently swallowed, no crash
# ---------------------------------------------------------------------------

def test_regression_oserror_on_log_write_does_not_propagate(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """If writing _PNPM_ERROR_LOG raises OSError (read-only fs, permission denied),
    _install_sidecar() must NOT propagate the exception — it still returns the
    pnpm exit code."""
    def _bad_log_write(*args, **kwargs):
        raise OSError("read-only file system")

    error_log = tmp_path / ".photon-pnpm-error.log"
    # Monkey-patch write_text on the Path object via a subclass
    class _UnwritablePath(type(error_log)):
        def write_text(self, *a, **kw):
            raise OSError("read-only file system")
        def unlink(self, *a, **kw):
            raise OSError("read-only file system")
        def exists(self):
            return False

    _stub_pnpm(monkeypatch, 1, "ERR_PNPM_FETCH_404  not found")
    monkeypatch.setattr(cli_mod, "_PNPM_ERROR_LOG", _UnwritablePath(error_log))

    rc = cli_mod._install_sidecar()
    assert rc == 1  # still returns the pnpm exit code


# ---------------------------------------------------------------------------
# 3. OSError on log read in check_requirements() — silently swallowed
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# 4. Empty output — log file NOT written
# ---------------------------------------------------------------------------

def test_regression_empty_output_does_not_write_log(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """If pnpm fails but printed nothing, _PNPM_ERROR_LOG must
    NOT be written — an empty file would mislead check_requirements()."""
    error_log = tmp_path / ".photon-pnpm-error.log"
    _stub_pnpm(monkeypatch, 1, "")
    monkeypatch.setattr(cli_mod, "_PNPM_ERROR_LOG", error_log)

    cli_mod._install_sidecar()

    assert not error_log.exists(), (
        "_PNPM_ERROR_LOG must not be created when the output is empty"
    )


# ---------------------------------------------------------------------------
# 5. Cleanup and bounding of the persisted log
# ---------------------------------------------------------------------------

def test_regression_permissionerror_on_success_unlink_does_not_propagate(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A successful pnpm install must still return 0 even if deleting the
    stale _PNPM_ERROR_LOG raises something other than FileNotFoundError
    (e.g. PermissionError on a locked file) — the unlink is best-effort."""
    error_log = tmp_path / ".photon-pnpm-error.log"

    class _UnremovablePath(type(error_log)):
        def unlink(self, *a, **kw):
            raise PermissionError("access denied")

    _stub_pnpm(monkeypatch, 0, "")
    monkeypatch.setattr(cli_mod, "_PNPM_ERROR_LOG", _UnremovablePath(error_log))

    rc = cli_mod._install_sidecar()
    assert rc == 0  # PermissionError on cleanup must not fail the install


def test_regression_long_output_truncated_before_write(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A huge pnpm output must be bounded before it hits disk, not just when
    read back later — otherwise a verbose pnpm failure writes an unbounded
    file to the sidecar directory on every retry."""
    error_log = tmp_path / ".photon-pnpm-error.log"
    huge_output = "ERR_PNPM_FETCH_404  " + ("x" * 10_000)

    _stub_pnpm(monkeypatch, 1, huge_output)
    monkeypatch.setattr(cli_mod, "_PNPM_ERROR_LOG", error_log)

    cli_mod._install_sidecar()

    written = error_log.read_text(encoding="utf-8")
    assert len(written) <= cli_mod._PNPM_ERROR_LOG_MAX_CHARS


def test_regression_missing_pnpm_returns_1_without_running(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture
) -> None:
    """No pnpm (Node tooling missing) is reported, nothing is run or logged."""
    calls = _stub_pnpm(monkeypatch, 0)
    monkeypatch.setattr("hermes_constants.ensure_hermes_pnpm", lambda: None, raising=False)
    error_log = tmp_path / ".photon-pnpm-error.log"
    monkeypatch.setattr(cli_mod, "_PNPM_ERROR_LOG", error_log)

    assert cli_mod._install_sidecar() == 1
    assert calls == []
    assert not error_log.exists()
    assert "pnpm is not available" in capsys.readouterr().err


def test_regression_frozen_install_then_plain_install_fallback(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The sidecar is not a workspace member: every install ignores the root
    workspace, and the lockfile is only allowed to change on the fallback."""
    calls = _stub_pnpm(monkeypatch, 1, "ERR_PNPM_OUTDATED_LOCKFILE  drifted")
    monkeypatch.setattr(cli_mod, "_PNPM_ERROR_LOG", tmp_path / ".photon-pnpm-error.log")

    cli_mod._install_sidecar()

    assert calls == [
        ["/managed/pnpm", "install", "--ignore-workspace", "--frozen-lockfile"],
        ["/managed/pnpm", "install", "--ignore-workspace"],
    ]


def test_regression_persisted_error_starts_at_the_pnpm_error_line(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """pnpm prints progress before its ERR_PNPM_ line; persisting the head of
    the output would surface "Lockfile is up to date" as the failure reason."""
    error_log = tmp_path / ".photon-pnpm-error.log"
    output = (
        "Lockfile is up to date, resolution step is skipped\n"
        "Progress: resolved 1, reused 0, downloaded 0, added 0\n"
        " ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/spectrum-ts: Not Found - 404\n"
    )
    _stub_pnpm(monkeypatch, 1, output)
    monkeypatch.setattr(cli_mod, "_PNPM_ERROR_LOG", error_log)

    cli_mod._install_sidecar()

    written = error_log.read_text(encoding="utf-8")
    assert written.startswith("ERR_PNPM_FETCH_404")
    assert "Lockfile is up to date" not in written


def test_regression_run_pnpm_captures_stdout_and_stderr(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture
) -> None:
    """pnpm reports ERR_PNPM_* on stdout, so both streams must be returned
    (and still echoed to the terminal)."""
    monkeypatch.setattr(cli_mod, "_SIDECAR_DIR", tmp_path)
    script = (
        "import sys; print('ERR_PNPM_X  on stdout'); "
        "print('warn on stderr', file=sys.stderr); sys.exit(3)"
    )

    returncode, output = cli_mod._run_pnpm([sys.executable, "-c", script])

    assert returncode == 3
    assert "ERR_PNPM_X  on stdout" in output
    assert "warn on stderr" in output
    assert "ERR_PNPM_X  on stdout" in capsys.readouterr().out


# ---------------------------------------------------------------------------
# 6. Stale log cleared on success — no phantom errors after reinstall
# ---------------------------------------------------------------------------

def test_regression_stale_log_not_surfaced_after_successful_reinstall(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """If pnpm install succeeds on a retry but a stale _PNPM_ERROR_LOG from the
    prior failed run still exists, check_requirements() must NOT surface the
    stale error after the successful reinstall clears it."""
    error_log = tmp_path / ".photon-pnpm-error.log"
    error_log.write_text("stale: ERR_PNPM_FETCH_404 old failure", encoding="utf-8")

    # Successful reinstall clears the log
    _stub_pnpm(monkeypatch, 0, "")
    monkeypatch.setattr(cli_mod, "_PNPM_ERROR_LOG", error_log)
    cli_mod._install_sidecar()
    assert not error_log.exists(), "Success must clear the stale error log"

    # Now check_requirements() must not mention the old error
    # Create spectrum-ts inside node_modules/ — the content check requires it.
    (tmp_path / "node_modules" / "spectrum-ts").mkdir(parents=True)
    monkeypatch.setattr(adapter_mod, "HTTPX_AVAILABLE", True)
    monkeypatch.setattr(adapter_mod, "_SIDECAR_DIR", tmp_path)
    monkeypatch.setattr(adapter_mod, "_PNPM_ERROR_LOG", error_log)

    with caplog.at_level(logging.DEBUG, logger="plugins.platforms.photon.adapter"):
        result = adapter_mod.check_requirements()

    assert result is True
    assert not any("stale" in r.message for r in caplog.records)


# ---------------------------------------------------------------------------
# 7. check_requirements() without error log — debug log still emitted
# ---------------------------------------------------------------------------

@_requires_node
def test_regression_debug_log_emitted_even_without_error_log(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """When node_modules is missing and no _PNPM_ERROR_LOG exists (first-time
    setup, not a failed install), check_requirements() must still emit a DEBUG
    line pointing to the sidecar path."""
    monkeypatch.setattr(adapter_mod, "HTTPX_AVAILABLE", True)
    monkeypatch.setattr(adapter_mod, "_SIDECAR_DIR", tmp_path)
    monkeypatch.setattr(adapter_mod, "_PNPM_ERROR_LOG", tmp_path / ".photon-pnpm-error.log")
    # NS-606: disable self-heal so the debug-log branch is reached.
    monkeypatch.setattr(adapter_mod, "_dir_writable", lambda _p: False)
    # node_modules NOT created, error log NOT created

    with caplog.at_level(logging.DEBUG, logger="plugins.platforms.photon.adapter"):
        result = adapter_mod.check_requirements()

    assert result is False
    debug_messages = [r.message for r in caplog.records if r.levelno == logging.DEBUG]
    assert any(str(tmp_path) in m for m in debug_messages), (
        f"Expected DEBUG with sidecar path even without error log, got: {debug_messages}"
    )
