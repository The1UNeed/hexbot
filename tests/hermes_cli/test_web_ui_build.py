"""Tests for _web_ui_build_needed — staleness check for the web UI dist.

The freshness check uses a SHA-256 content hash of the web source tree
(mirroring the desktop build), recorded in a stamp file under $HERMES_HOME,
NOT mtime comparison — so ``git pull`` / ``hexbot core update`` that rewrite
source mtimes without changing content no longer fool it.

Critical invariant: the dashboard Vite build outputs to hermes_cli/web_dist/
(vite.config.ts: outDir: "../../hermes_cli/web_dist"), NOT web/dist/.
The sentinel must be checked in the correct output directory or the
freshness check is a no-op and the OOM rebuild always runs.
"""

import os
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from hermes_cli.main import (
    _web_ui_build_needed,
    _build_web_ui,
    _compute_web_ui_content_hash,
    _missing_web_build_tool,
    _run_pnpm_install_deterministic,
    _web_build_toolchain_ready,
    _web_toolchain_roots,
    _web_ui_stamp_path,
    _write_web_ui_build_stamp,
)


@pytest.fixture(autouse=True)
def _isolated_hermes_home(tmp_path, monkeypatch):
    """Keep web-build-stamp writes inside the test's tmp dir, never the real home."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "_hermes_home"))


def _touch(path: Path, offset: float = 0.0) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch()
    if offset:
        t = time.time() + offset
        os.utime(path, (t, t))


def _make_web_dir(tmp_path: Path) -> tuple[Path, Path]:
    """Return (web_dir, dist_dir) matching real repo layout."""
    web_dir = tmp_path / "web"
    web_dir.mkdir(parents=True)
    (web_dir / "package.json").touch()
    dist_dir = tmp_path / "hermes_cli" / "web_dist"
    return web_dir, dist_dir


class TestWebUIBuildNeeded:
    """Content-hash staleness — replaces the old mtime comparison.

    The dashboard build hashes the web source tree (like the desktop build)
    instead of comparing mtimes, so git operations that rewrite mtimes
    without changing content no longer fool the freshness check.
    """

    @staticmethod
    def _root(web_dir: Path) -> Path:
        return web_dir.parent.parent if web_dir.parent.name == "apps" else web_dir.parent

    def _stamp_current(self, web_dir: Path) -> None:
        """Record a stamp matching web_dir's current source content."""
        _write_web_ui_build_stamp(self._root(web_dir), web_dir)





    def test_mtime_only_change_is_not_stale(self, tmp_path):
        """The whole point: bumping mtimes without changing bytes (what
        ``git pull`` / ``hexbot core update`` do) must NOT report stale."""
        web_dir, dist_dir = _make_web_dir(tmp_path)
        src = web_dir / "src" / "App.tsx"
        src.parent.mkdir(parents=True, exist_ok=True)
        src.write_text("export const A = 1\n")
        (dist_dir / ".vite").mkdir(parents=True, exist_ok=True)
        (dist_dir / ".vite" / "manifest.json").write_text("{}")
        self._stamp_current(web_dir)
        assert _web_ui_build_needed(web_dir) is False
        future = time.time() + 10_000
        os.utime(src, (future, future))
        os.utime(web_dir / "package.json", (future, future))
        assert _web_ui_build_needed(web_dir) is False



    def test_content_hash_is_deterministic(self, tmp_path):
        web_dir, _ = _make_web_dir(tmp_path)
        (web_dir / "src").mkdir(parents=True, exist_ok=True)
        (web_dir / "src" / "App.tsx").write_text("export const A = 1\n")
        root = self._root(web_dir)
        h1 = _compute_web_ui_content_hash(root, web_dir)
        h2 = _compute_web_ui_content_hash(root, web_dir)
        assert h1 == h2
        assert len(h1) == 64

    def test_write_stamp_creates_file_with_hash(self, tmp_path):
        import json as _json
        web_dir, _ = _make_web_dir(tmp_path)
        (web_dir / "src").mkdir(parents=True, exist_ok=True)
        (web_dir / "src" / "App.tsx").write_text("export const A = 1\n")
        self._stamp_current(web_dir)
        stamp = _web_ui_stamp_path()
        assert stamp.is_file()
        data = _json.loads(stamp.read_text())
        assert data["contentHash"] == _compute_web_ui_content_hash(self._root(web_dir), web_dir)



class TestBuildWebUISkipsWhenFresh:







    def test_web_install_omits_filter_and_scrubs_esbuild_override(
        self, tmp_path, monkeypatch
    ):
        """web/ with its own lockfile => _workspace_root returns web_dir, so
        there is no workspace to filter and the install runs plainly from
        web_dir. Symmetric to the TUI case in test_tui_pnpm_install.py.
        See #42973.

        With web's own lockfile present at cwd, _run_pnpm_install_deterministic
        uses ``pnpm install --frozen-lockfile``. The shared installer must also
        remove an inherited esbuild binary override so package/binary versions
        cannot diverge (#87405).
        """
        web_dir, _ = _make_web_dir(tmp_path)
        (web_dir / "pnpm-lock.yaml").write_text("", encoding="utf-8")
        (tmp_path / "pnpm-workspace.yaml").write_text("packages:\n  - web\n", encoding="utf-8")
        (tmp_path / "pnpm-lock.yaml").write_text("", encoding="utf-8")
        monkeypatch.delenv("TERMUX_VERSION", raising=False)
        monkeypatch.setenv("PREFIX", "/usr")
        monkeypatch.setenv("ESBUILD_BINARY_PATH", "/opt/esbuild-0.28.2")

        install_cp = __import__("subprocess").CompletedProcess([], 0, stdout="", stderr="")
        build_cp = __import__("subprocess").CompletedProcess([], 0, stdout="", stderr="")
        with patch("hermes_constants.ensure_hermes_pnpm", return_value="/usr/bin/pnpm"), \
             patch("hermes_cli.main.subprocess.run", return_value=install_cp) as mock_run, \
             patch("hermes_cli.main._run_with_idle_timeout", return_value=build_cp) as mock_build:
            result = _build_web_ui(web_dir)

        assert result is True
        args, kwargs = mock_run.call_args
        assert args[0] == [
            "/usr/bin/pnpm", "install", "--frozen-lockfile", "--prod=false", "--prefer-offline",
        ]
        assert kwargs["cwd"] == web_dir
        assert "ESBUILD_BINARY_PATH" not in kwargs["env"]
        assert "ESBUILD_BINARY_PATH" not in mock_build.call_args.kwargs["env"]

    def test_workspace_root_install_filters_to_web(self, tmp_path, monkeypatch):
        """From the workspace root, _build_web_ui installs only the web
        workspace and the workspace packages it depends on, so apps/desktop
        (Electron + node-pty) is never resolved. See #38772.

        A filtered pnpm install covers the workspace root and leaves the
        node_modules of unselected workspaces in place, so other workspaces
        need not be named to survive it.
        """
        web_dir, _ = _make_web_dir(tmp_path)
        (tmp_path / "pnpm-workspace.yaml").write_text("packages:\n  - web\n", encoding="utf-8")
        (tmp_path / "pnpm-lock.yaml").write_text("", encoding="utf-8")
        (tmp_path / "ui-tui").mkdir()
        (tmp_path / "ui-tui" / "package.json").write_text("{}", encoding="utf-8")
        monkeypatch.delenv("TERMUX_VERSION", raising=False)
        monkeypatch.setenv("PREFIX", "/usr")

        install_cp = __import__("subprocess").CompletedProcess([], 0, stdout="", stderr="")
        build_cp = __import__("subprocess").CompletedProcess([], 0, stdout="", stderr="")
        with patch("hermes_constants.ensure_hermes_pnpm", return_value="/usr/bin/pnpm"), \
             patch("hermes_cli.main.subprocess.run", return_value=install_cp) as mock_run, \
             patch("hermes_cli.main._run_with_idle_timeout", return_value=build_cp):
            result = _build_web_ui(web_dir)

        assert result is True
        args, kwargs = mock_run.call_args
        assert args[0] == [
            "/usr/bin/pnpm", "install", "--frozen-lockfile", "--prod=false",
            "--filter", "{web}...", "--prefer-offline",
        ]
        assert kwargs["cwd"] == tmp_path

    def test_failed_install_relays_pnpm_stdout_and_pnpm_hint(self, tmp_path, capsys):
        """pnpm reports ERR_PNPM_* on stdout; the user must see it, plus the
        pnpm command to run by hand."""
        web_dir, _ = _make_web_dir(tmp_path)
        install_fail = __import__("subprocess").CompletedProcess(
            [], 1, stdout=" ERR_PNPM_FETCH_404  GET https://x/foo: Not Found", stderr=""
        )
        with patch("hermes_constants.ensure_hermes_pnpm", return_value="/usr/bin/pnpm"), \
             patch("hermes_cli.main.subprocess.run", return_value=install_fail):
            result = _build_web_ui(web_dir, fatal=True)

        assert result is False
        out = capsys.readouterr().out
        assert "Web UI pnpm install failed" in out
        assert "ERR_PNPM_FETCH_404" in out
        assert "pnpm install --filter web... && pnpm --filter web run build" in out

    def test_web_build_uses_idle_timeout_helper(self, tmp_path):
        """pnpm run build now goes through _run_with_idle_timeout (issue #33788).

        The install step keeps its capture_output behavior (the existing
        retry-on-EPERM contract depends on it); only the long-running build
        step is streamed + idle-killed.
        """
        web_dir, _ = _make_web_dir(tmp_path)

        install_cp = __import__("subprocess").CompletedProcess([], 0, stdout="", stderr="")
        build_cp = __import__("subprocess").CompletedProcess([], 0, stdout="", stderr="")
        with patch("hermes_constants.ensure_hermes_pnpm", return_value="/usr/bin/pnpm"), \
             patch("hermes_cli.main.subprocess.run", return_value=install_cp), \
             patch("hermes_cli.main._run_with_idle_timeout", return_value=build_cp) as mock_idle:
            result = _build_web_ui(web_dir)

        assert result is True
        # Build was invoked through the idle-timeout helper, not subprocess.run.
        mock_idle.assert_called_once()
        args, kwargs = mock_idle.call_args
        # Positional: [pnpm, "run", "build"]; cwd passed as kwarg.
        assert args[0] == ["/usr/bin/pnpm", "run", "build"]
        assert kwargs["cwd"] == web_dir


class TestBuildWebUIRetryAndStaleFallback:
    """Coverage for the retry + stale-dist fallback added in #23824 / issue #23817."""

    def test_retries_build_once_on_failure(self, tmp_path):
        web_dir, _ = _make_web_dir(tmp_path)
        Subprocess = __import__("subprocess")
        install_ok = Subprocess.CompletedProcess([], 0, stdout="", stderr="")
        # build attempt 1: fail; build attempt 2: success.
        build_fail = Subprocess.CompletedProcess([], 1, stdout="EPERM", stderr="")
        build_ok = Subprocess.CompletedProcess([], 0, stdout="", stderr="")
        with patch("hermes_constants.ensure_hermes_pnpm", return_value="/usr/bin/pnpm"), \
             patch("hermes_cli.main._time.sleep") as mock_sleep, \
             patch("hermes_cli.main.subprocess.run", return_value=install_ok), \
             patch("hermes_cli.main._run_with_idle_timeout",
                   side_effect=[build_fail, build_ok]) as mock_idle:
            result = _build_web_ui(web_dir)

        assert result is True
        assert mock_idle.call_count == 2  # build + retry
        mock_sleep.assert_called_once_with(3)

    def test_falls_back_to_stale_dist_when_retry_also_fails(self, tmp_path, capsys):
        web_dir, dist_dir = _make_web_dir(tmp_path)
        # Stale dist exists but is older than source
        _touch(dist_dir / "index.html", offset=-100)
        _touch(web_dir / "src" / "App.tsx")  # newer source -> build_needed=True

        Subprocess = __import__("subprocess")
        install_ok = Subprocess.CompletedProcess([], 0, stdout="", stderr="")
        build_fail = Subprocess.CompletedProcess([], 1, stdout="vite ENOMEM", stderr="")
        with patch("hermes_constants.ensure_hermes_pnpm", return_value="/usr/bin/pnpm"), \
             patch("hermes_cli.main._time.sleep"), \
             patch("hermes_cli.main.subprocess.run", return_value=install_ok), \
             patch("hermes_cli.main._run_with_idle_timeout",
                   side_effect=[build_fail, build_fail]):
            result = _build_web_ui(web_dir, fatal=True)

        # MUST return True (serve stale) — issue #23817 — even with fatal=True,
        # because cmd_dashboard passes fatal=True and is the primary caller.
        assert result is True
        out = capsys.readouterr().out
        assert "serving stale dist as fallback" in out
        assert "vite ENOMEM" in out  # combined output surfaced to user


class TestBuildWebUIFlock:
    """Cross-process build serialization (salvaged from PR #63455).

    One process builds under an exclusive flock on <root>/.web_ui_build.lock;
    contenders either serve the existing (possibly stale) dist or, when no
    dist exists yet, block until the builder finishes. The staleness walk
    itself runs inside _do_build_web_ui, i.e. under the lock, so a process
    that queued behind a successful build skips the rebuild.
    """



    def test_contended_lock_without_dist_waits_then_skips_fresh_build(self, tmp_path):
        """First-ever build race: the waiter blocks, and once it acquires the
        lock the callee's own staleness check (running under the lock) sees
        the winner's output and skips a duplicate build."""
        import fcntl
        import threading
        from hermes_cli.main import _build_web_ui as build

        web_dir, dist_dir = _make_web_dir(tmp_path)
        # No dist yet — contender must take the blocking-wait path.
        lock_path = tmp_path / ".web_ui_build.lock"
        holder = open(lock_path, "a")
        fcntl.flock(holder.fileno(), fcntl.LOCK_EX)

        def release_after_building():
            # Simulate the winning process finishing its build.
            _touch(dist_dir / ".vite" / "manifest.json")
            _write_web_ui_build_stamp(tmp_path, web_dir)
            holder.close()  # releases the flock

        t = threading.Timer(0.2, release_after_building)
        t.start()
        try:
            with patch("hermes_constants.ensure_hermes_pnpm", return_value="/usr/bin/pnpm"), \
                 patch("hermes_cli.main.subprocess.run") as mock_run:
                result = build(web_dir)
        finally:
            t.join()

        assert result is True
        mock_run.assert_not_called()  # fresh after the wait -> no rebuild

    def test_lock_file_is_gitignored(self):
        gitignore = Path(__file__).resolve().parents[2] / ".gitignore"
        assert ".web_ui_build.lock" in gitignore.read_text(encoding="utf-8")


def _link_shims(bin_dir: Path, *names: str) -> None:
    bin_dir.mkdir(parents=True, exist_ok=True)
    for name in names:
        (bin_dir / name).touch()


class TestWebBuildToolchainReady:
    """A tree is ready when the build can resolve tsc AND vite from any root.

    ``pnpm run build`` searches ``node_modules/.bin`` of the script's own
    package and of the workspace root, so a shim in either place counts.
    """

    def test_missing_toolchain_is_not_ready(self, tmp_path):
        web_dir, _ = _make_web_dir(tmp_path)
        assert _web_build_toolchain_ready(web_dir, tmp_path) is False


    def test_shims_linked_into_the_member_are_ready(self, tmp_path):
        """pnpm links a member's binaries into its own node_modules/.bin."""
        web_dir, _ = _make_web_dir(tmp_path)
        _link_shims(web_dir / "node_modules" / ".bin", "tsc", "vite")
        assert _web_build_toolchain_ready(web_dir, tmp_path) is True

    def test_shims_at_workspace_root_are_ready(self, tmp_path):
        web_dir, _ = _make_web_dir(tmp_path)
        _link_shims(tmp_path / "node_modules" / ".bin", "tsc", "vite")
        assert _web_build_toolchain_ready(web_dir, tmp_path) is True


    @pytest.mark.parametrize("shim", ["tsc.cmd", "tsc.ps1", "tsc.exe"])
    def test_windows_shim_extensions_count(self, tmp_path, shim):
        web_dir, _ = _make_web_dir(tmp_path)
        _link_shims(tmp_path / "node_modules" / ".bin", shim, "vite.cmd")
        assert _web_build_toolchain_ready(web_dir, tmp_path) is True


class TestWebToolchainRoots:
    def test_searches_the_package_and_its_workspace_root(self, tmp_path):
        web_dir, _ = _make_web_dir(tmp_path)
        assert _web_toolchain_roots(web_dir) == (web_dir, tmp_path)


class TestMissingWebBuildTool:
    """Every shell words an unresolvable binary differently."""

    @pytest.mark.parametrize(
        "output,expected",
        [
            ("sh: 1: tsc: not found\n ELIFECYCLE  Command failed with exit code 127.", "tsc"),
            ("bash: line 1: vite: command not found", "vite"),
            ("'tsc' is not recognized as an internal or external command", "tsc"),
            ("error TS2307: Cannot find module './x'", None),
            ("", None),
        ],
    )
    def test_detects_the_unresolvable_tool(self, output, expected):
        assert _missing_web_build_tool(output) == expected


class TestBuildRecoversFromMissingToolchain:
    def test_reinstalls_and_retries_when_the_build_cannot_resolve_tsc(self, tmp_path):
        """The generic retry reruns the same command, so it can't fix this alone."""
        web_dir, _ = _make_web_dir(tmp_path)
        (tmp_path / "pnpm-lock.yaml").write_text("", encoding="utf-8")
        install_ok = __import__("subprocess").CompletedProcess([], 0, stdout="", stderr="")
        build_fail = __import__("subprocess").CompletedProcess(
            [], 127, stdout="sh: 1: tsc: not found\n", stderr=""
        )
        build_ok = __import__("subprocess").CompletedProcess([], 0, stdout="", stderr="")

        with patch("hermes_cli.main._resolve_node_runtime_pnpm", return_value="/usr/bin/pnpm"), \
             patch("hermes_cli.main._run_pnpm_install_deterministic", return_value=install_ok) as mock_install, \
             patch("hermes_cli.main._run_with_idle_timeout", side_effect=[build_fail, build_ok]) as mock_build, \
             patch("hermes_cli.main._web_ui_build_needed", return_value=True), \
             patch("hermes_cli.main._write_web_ui_build_stamp"), \
             patch("hermes_cli.main._time.sleep"):
            result = _build_web_ui(web_dir)

        assert result is True
        assert mock_install.call_count == 2
        assert mock_build.call_count == 2

    def test_healthy_tree_builds_without_an_extra_install(self, tmp_path):
        """No pre-build probing: a build that works is never second-guessed."""
        web_dir, _ = _make_web_dir(tmp_path)
        (tmp_path / "pnpm-lock.yaml").write_text("", encoding="utf-8")
        _link_shims(web_dir / "node_modules" / ".bin", "tsc", "vite")
        install_ok = __import__("subprocess").CompletedProcess([], 0, stdout="", stderr="")
        build_ok = __import__("subprocess").CompletedProcess([], 0, stdout="", stderr="")

        with patch("hermes_cli.main._resolve_node_runtime_pnpm", return_value="/usr/bin/pnpm"), \
             patch("hermes_cli.main._run_pnpm_install_deterministic", return_value=install_ok) as mock_install, \
             patch("hermes_cli.main._run_with_idle_timeout", return_value=build_ok) as mock_build, \
             patch("hermes_cli.main._web_ui_build_needed", return_value=True), \
             patch("hermes_cli.main._write_web_ui_build_stamp"):
            result = _build_web_ui(web_dir)

        assert result is True
        assert mock_install.call_count == 1
        assert mock_build.call_count == 1

