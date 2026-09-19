"""Behavioral coverage for required Node dependency installation."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALL_SH = REPO_ROOT / "scripts" / "install.sh"


def _write_executable(path: Path, body: str) -> None:
    path.write_text(body, encoding="utf-8")
    path.chmod(0o755)


def _run_node_deps_stage(
    tmp_path: Path,
    *,
    fail_directory: str | None,
) -> tuple[subprocess.CompletedProcess[str], Path, list[str]]:
    install_dir = tmp_path / "install"
    tui_dir = install_dir / "ui-tui"
    bin_dir = tmp_path / "bin"
    hermes_home = tmp_path / "home"
    managed_bin = hermes_home / "bin"
    pnpm_calls = tmp_path / "pnpm-calls"

    tui_dir.mkdir(parents=True)
    bin_dir.mkdir()
    managed_bin.mkdir(parents=True)
    (install_dir / "package.json").write_text(
        '{"name":"installer-regression-probe","private":true,'
        '"packageManager":"pnpm@10.29.3"}\n',
        encoding="utf-8",
    )
    (tui_dir / "package.json").write_text(
        '{"name":"tui-regression-probe","private":true}\n',
        encoding="utf-8",
    )
    _write_executable(bin_dir / "node", "#!/bin/sh\necho v26.0.0\n")
    _write_executable(bin_dir / "npm", "#!/bin/sh\necho 12.0.0\n")
    _write_executable(
        bin_dir / "pnpm",
        """#!/bin/sh
if [ "${1:-}" = "--version" ]; then
    echo 10.29.3
    exit 0
fi
printf '%s\\n' "$PWD" >> "$PNPM_CALLS"
printf '%s\\n' "$*" >> "$PNPM_CALLS.args"
if [ -n "${PNPM_FAIL_DIRECTORY:-}" ] && [ "$PWD" = "$PNPM_FAIL_DIRECTORY" ]; then
    echo "simulated pnpm lifecycle failure" >&2
    exit 37
fi
exit 0
""",
    )
    _write_executable(managed_bin / "uv", "#!/bin/sh\necho 'uv probe'\n")

    env = os.environ.copy()
    env.update(
        {
            "HERMES_HOME": str(hermes_home),
            "HERMES_INSTALL_DIR": str(install_dir),
            "PNPM_CALLS": str(pnpm_calls),
            "PNPM_FAIL_DIRECTORY": fail_directory or "",
            "PATH": f"{bin_dir}:{env['PATH']}",
        }
    )
    proc = subprocess.run(
        [
            "bash",
            str(INSTALL_SH),
            "--stage",
            "node-deps",
            "--json",
            "--skip-browser",
            "--skip-computer-use",
        ],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    calls = pnpm_calls.read_text(encoding="utf-8").splitlines()
    return proc, install_dir, calls


def _stage_result(proc: subprocess.CompletedProcess[str]) -> dict[str, object]:
    return json.loads(proc.stdout.splitlines()[-1])


def test_root_node_dependency_failure_is_fatal(tmp_path: Path) -> None:
    install_dir = tmp_path / "install"
    proc, actual_install_dir, calls = _run_node_deps_stage(
        tmp_path,
        fail_directory=str(install_dir),
    )

    assert actual_install_dir == install_dir
    assert proc.returncode != 0
    assert _stage_result(proc) == {
        "ok": False,
        "stage": "node-deps",
        "skipped": False,
        "reason": "exit code 1",
    }
    assert calls == [str(install_dir)]
    assert "Node.js dependencies installed" not in proc.stdout
    assert "TUI dependencies installed" not in proc.stdout
    assert not (install_dir / "node_modules").exists()


def test_tui_node_dependency_failure_is_fatal(tmp_path: Path) -> None:
    install_dir = tmp_path / "install"
    tui_dir = install_dir / "ui-tui"
    proc, _, calls = _run_node_deps_stage(
        tmp_path,
        fail_directory=str(tui_dir),
    )

    assert proc.returncode != 0
    assert _stage_result(proc)["ok"] is False
    assert calls == [str(install_dir), str(tui_dir)]
    assert "Node.js dependencies installed" in proc.stdout
    assert "TUI dependencies installed" not in proc.stdout


def test_node_dependency_success_remains_successful(tmp_path: Path) -> None:
    proc, install_dir, calls = _run_node_deps_stage(
        tmp_path,
        fail_directory=None,
    )

    assert proc.returncode == 0, proc.stderr
    assert _stage_result(proc) == {
        "ok": True,
        "stage": "node-deps",
        "skipped": False,
    }
    assert calls == [str(install_dir), str(install_dir / "ui-tui")]
    assert "Node.js dependencies installed" in proc.stdout
    assert "TUI dependencies installed" in proc.stdout
    # Every install is frozen, so the tracked lockfile is never rewritten, and
    # the root one is scoped away from apps/*.
    args = (tmp_path / "pnpm-calls.args").read_text(encoding="utf-8").splitlines()
    assert args == [
        "install --frozen-lockfile --filter ui-tui... --reporter=append-only",
        "install --frozen-lockfile --reporter=append-only",
    ]
