"""_tui_need_pnpm_install: auto pnpm install when node_modules is behind the lockfile."""

import os
import types
from pathlib import Path

import pytest


@pytest.fixture
def main_mod(monkeypatch):
    import hermes_cli.main as m
    import hermes_constants

    # The launch resolves pnpm through ensure_hermes_pnpm(); never let a test
    # reach the real bootstrap.
    monkeypatch.setattr(hermes_constants, "ensure_hermes_pnpm", lambda: "/bin/pnpm")
    return m


def _touch_ink(root: Path) -> None:
    ink = root / "node_modules" / "@hermes" / "ink" / "package.json"
    ink.parent.mkdir(parents=True, exist_ok=True)
    ink.write_text("{}")


def _touch_tui_entry(root: Path) -> None:
    entry = root / "dist" / "entry.js"
    entry.parent.mkdir(parents=True, exist_ok=True)
    entry.write_text("console.log('tui')")


def _assert_utf8_replace_capture(kwargs: dict) -> None:
    assert kwargs["text"] is True
    assert kwargs["encoding"] == "utf-8"
    assert kwargs["errors"] == "replace"


def _write_lock_and_marker(root: Path, *, lock_mtime: int, marker_mtime: int) -> None:
    lock = root / "pnpm-lock.yaml"
    marker = root / "node_modules" / ".modules.yaml"
    marker.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text("lockfileVersion: '9.0'\n")
    marker.write_text("layoutVersion: 5\n")
    os.utime(lock, (lock_mtime, lock_mtime))
    os.utime(marker, (marker_mtime, marker_mtime))


def test_no_install_when_lock_older_than_marker(tmp_path: Path, main_mod) -> None:
    _touch_ink(tmp_path)
    _write_lock_and_marker(tmp_path, lock_mtime=100, marker_mtime=200)
    assert main_mod._tui_need_pnpm_install(tmp_path) is False


def test_need_install_when_lock_newer_than_marker(tmp_path: Path, main_mod) -> None:
    """pnpm rewrites .modules.yaml on every successful install, so a lockfile
    newer than it means node_modules is behind."""
    _touch_ink(tmp_path)
    _write_lock_and_marker(tmp_path, lock_mtime=200, marker_mtime=100)
    assert main_mod._tui_need_pnpm_install(tmp_path) is True


def test_need_install_when_marker_missing(tmp_path: Path, main_mod) -> None:
    _touch_ink(tmp_path)
    (tmp_path / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n")
    assert main_mod._tui_need_pnpm_install(tmp_path) is True


def test_need_install_when_ink_missing(tmp_path: Path, main_mod) -> None:
    _write_lock_and_marker(tmp_path, lock_mtime=100, marker_mtime=200)
    assert main_mod._tui_need_pnpm_install(tmp_path) is True


def test_no_install_without_lockfile_when_ink_present(tmp_path: Path, main_mod) -> None:
    _touch_ink(tmp_path)
    assert main_mod._tui_need_pnpm_install(tmp_path) is False


# ── workspace layout ────────────────────────────────────────────────
#
# In a workspace checkout the lockfile and pnpm's .modules.yaml marker live at
# the workspace root, while @hermes/ink is linked into ui-tui/node_modules
# (pnpm does not hoist).


def _write_ws(root: Path, *, lock_mtime: int, marker_mtime: int) -> Path:
    """Lay out a workspace root + ui-tui member and return the ui-tui dir."""
    (root / "pnpm-workspace.yaml").write_text("packages:\n  - ui-tui\n")
    _write_lock_and_marker(root, lock_mtime=lock_mtime, marker_mtime=marker_mtime)
    tui_dir = root / "ui-tui"
    tui_dir.mkdir(parents=True, exist_ok=True)
    (tui_dir / "package.json").write_text('{"name":"hermes-tui"}')
    return tui_dir


def test_workspace_layout_uses_root_lock_and_marker(tmp_path: Path, main_mod) -> None:
    tui_dir = _write_ws(tmp_path, lock_mtime=100, marker_mtime=200)
    _touch_ink(tui_dir)
    assert main_mod._tui_need_pnpm_install(tui_dir) is False

    os.utime(tmp_path / "pnpm-lock.yaml", (300, 300))
    assert main_mod._tui_need_pnpm_install(tui_dir) is True


def test_workspace_layout_needs_install_when_ink_not_linked_into_tui(
    tmp_path: Path, main_mod
) -> None:
    """A root-level @hermes/ink is not resolvable from ui-tui under pnpm, so
    only the member's own node_modules counts."""
    tui_dir = _write_ws(tmp_path, lock_mtime=100, marker_mtime=200)
    _touch_ink(tmp_path)
    assert main_mod._tui_need_pnpm_install(tui_dir) is True


def test_no_install_prebuilt_bundle_mode(tmp_path: Path, main_mod) -> None:
    """dist/entry.js present and no pnpm-lock.yaml → prebuilt bundle, skip pnpm install."""
    _touch_tui_entry(tmp_path)
    assert main_mod._tui_need_pnpm_install(tmp_path) is False


def test_need_rebuild_when_tui_bundle_missing(tmp_path: Path, main_mod) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "entry.tsx").write_text("console.log('src')")

    assert main_mod._tui_need_rebuild(tmp_path) is True


def test_no_rebuild_when_tui_bundle_newer_than_inputs(tmp_path: Path, main_mod) -> None:
    _touch_tui_entry(tmp_path)
    src = tmp_path / "src"
    src.mkdir()
    (src / "entry.tsx").write_text("console.log('src')")
    os.utime(src / "entry.tsx", (100, 100))
    os.utime(tmp_path / "dist" / "entry.js", (200, 200))

    assert main_mod._tui_need_rebuild(tmp_path) is False


def test_rebuild_when_tui_source_newer_than_bundle(tmp_path: Path, main_mod) -> None:
    _touch_tui_entry(tmp_path)
    src = tmp_path / "src"
    src.mkdir()
    (src / "entry.tsx").write_text("console.log('src')")
    os.utime(tmp_path / "dist" / "entry.js", (100, 100))
    os.utime(src / "entry.tsx", (200, 200))

    assert main_mod._tui_need_rebuild(tmp_path) is True


def test_make_tui_argv_skips_build_only_on_termux_when_fresh(
    tmp_path: Path, main_mod, monkeypatch
) -> None:
    _touch_tui_entry(tmp_path)
    monkeypatch.setenv("TERMUX_VERSION", "1")
    monkeypatch.setattr(main_mod, "_tui_need_pnpm_install", lambda _root: False)
    monkeypatch.setattr(main_mod, "_tui_need_rebuild", lambda _root: False)
    monkeypatch.setattr(main_mod.shutil, "which", lambda name: f"/bin/{name}")

    def fail_run(*_args, **_kwargs):
        raise AssertionError("fresh Termux TUI launch must not rebuild")

    monkeypatch.setattr(main_mod.subprocess, "run", fail_run)

    argv, cwd = main_mod._make_tui_argv(tmp_path, tui_dev=False)

    assert argv == ["/bin/node", "--expose-gc", str(tmp_path / "dist" / "entry.js")]
    assert cwd == tmp_path


def test_make_tui_argv_skips_install_on_termux_when_bundle_fresh(
    tmp_path: Path, main_mod, monkeypatch
) -> None:
    _touch_tui_entry(tmp_path)
    monkeypatch.setenv("TERMUX_VERSION", "1")
    monkeypatch.setattr(main_mod, "_tui_need_pnpm_install", lambda _root: True)
    monkeypatch.setattr(main_mod, "_tui_need_rebuild", lambda _root: False)
    monkeypatch.setattr(main_mod.shutil, "which", lambda name: f"/bin/{name}")

    def fail_run(*_args, **_kwargs):
        raise AssertionError("fresh Termux TUI launch must not run pnpm")

    monkeypatch.setattr(main_mod.subprocess, "run", fail_run)

    argv, cwd = main_mod._make_tui_argv(tmp_path, tui_dev=False)

    assert argv == ["/bin/node", "--expose-gc", str(tmp_path / "dist" / "entry.js")]
    assert cwd == tmp_path


def test_make_tui_argv_scopes_pnpm_install_on_termux_workspace(
    tmp_path: Path, main_mod, monkeypatch
) -> None:
    tui_dir = tmp_path / "ui-tui"
    tui_dir.mkdir()
    (tui_dir / "package.json").write_text("{}")
    ink_dir = tui_dir / "packages" / "hermes-ink"
    ink_dir.mkdir(parents=True)
    (ink_dir / "package.json").write_text("{}")
    (tmp_path / "pnpm-workspace.yaml").write_text("packages:\n  - ui-tui\n")
    (tmp_path / "pnpm-lock.yaml").write_text("")

    monkeypatch.setenv("TERMUX_VERSION", "1")
    monkeypatch.setattr(main_mod, "_tui_need_pnpm_install", lambda _root: True)
    monkeypatch.setattr(main_mod, "_tui_need_rebuild", lambda _root: True)
    monkeypatch.setattr(main_mod.shutil, "which", lambda name: f"/bin/{name}")
    calls = []

    def fake_run(*args, **kwargs):
        calls.append((args, kwargs))
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(main_mod.subprocess, "run", fake_run)

    main_mod._make_tui_argv(tui_dir, tui_dev=False)

    assert calls[0][0][0] == [
        "/bin/pnpm",
        "install",
        "--frozen-lockfile",
        "--prod=false",
        "--filter",
        "{ui-tui}...",
        "--filter",
        "{ui-tui/packages/hermes-ink}...",
    ]
    assert Path(calls[0][1]["cwd"]) == tmp_path
    _assert_utf8_replace_capture(calls[0][1])
    _assert_utf8_replace_capture(calls[1][1])


def test_make_tui_argv_keeps_desktop_workspace_install_behaviour(
    tmp_path: Path, main_mod, monkeypatch
) -> None:
    tui_dir = tmp_path / "ui-tui"
    tui_dir.mkdir()
    (tui_dir / "package.json").write_text("{}")
    (tmp_path / "pnpm-workspace.yaml").write_text("packages:\n  - ui-tui\n")
    (tmp_path / "pnpm-lock.yaml").write_text("")

    monkeypatch.delenv("TERMUX_VERSION", raising=False)
    monkeypatch.setenv("PREFIX", "/usr")
    monkeypatch.setattr(main_mod, "_tui_need_pnpm_install", lambda _root: True)
    monkeypatch.setattr(main_mod.shutil, "which", lambda name: f"/bin/{name}")
    calls = []

    def fake_run(*args, **kwargs):
        calls.append((args, kwargs))
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(main_mod.subprocess, "run", fake_run)

    main_mod._make_tui_argv(tui_dir, tui_dev=False)

    assert calls[0][0][0] == [
        "/bin/pnpm",
        "install",
        "--frozen-lockfile",
        "--prod=false",
        "--filter",
        "{ui-tui}...",
    ]
    assert Path(calls[0][1]["cwd"]) == tmp_path
    _assert_utf8_replace_capture(calls[0][1])
    _assert_utf8_replace_capture(calls[1][1])


def test_make_tui_argv_pnpm_install_forces_dev_dependencies(
    tmp_path: Path, main_mod, monkeypatch
) -> None:
    """The TUI-launch pnpm install must force --prod=false: ui-tui's build
    toolchain (esbuild, typescript) lives in devDependencies, and an inherited
    NODE_ENV=production (container shells; a parent TUI sets it on its own
    subprocess env) would silently skip them, breaking the TUI build with
    `tsc`/`esbuild: command not found."""
    tui_dir = tmp_path / "ui-tui"
    tui_dir.mkdir()
    (tui_dir / "package.json").write_text("{}")
    (tmp_path / "pnpm-workspace.yaml").write_text("packages:\n  - ui-tui\n")
    (tmp_path / "pnpm-lock.yaml").write_text("")

    monkeypatch.delenv("TERMUX_VERSION", raising=False)
    monkeypatch.setenv("PREFIX", "/usr")
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setattr(main_mod, "_tui_need_pnpm_install", lambda _root: True)
    monkeypatch.setattr(main_mod.shutil, "which", lambda name: f"/bin/{name}")
    calls = []

    def fake_run(*args, **kwargs):
        calls.append((args, kwargs))
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(main_mod.subprocess, "run", fake_run)

    main_mod._make_tui_argv(tui_dir, tui_dev=False)

    install_cmd = calls[0][0][0]
    assert install_cmd[:2] == ["/bin/pnpm", "install"]
    assert "--prod=false" in install_cmd


def test_make_tui_argv_keeps_desktop_always_build_behaviour(
    tmp_path: Path, main_mod, monkeypatch
) -> None:
    _touch_tui_entry(tmp_path)
    monkeypatch.delenv("TERMUX_VERSION", raising=False)
    monkeypatch.setenv("PREFIX", "/usr")
    monkeypatch.setattr(main_mod, "_tui_need_pnpm_install", lambda _root: False)
    monkeypatch.setattr(main_mod, "_tui_need_rebuild", lambda _root: False)
    monkeypatch.setattr(main_mod.shutil, "which", lambda name: f"/bin/{name}")
    calls = []

    def fake_run(*args, **kwargs):
        calls.append((args, kwargs))
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(main_mod.subprocess, "run", fake_run)

    main_mod._make_tui_argv(tmp_path, tui_dev=False)

    assert calls
    assert calls[0][0][0] == ["/bin/pnpm", "run", "build"]
    _assert_utf8_replace_capture(calls[0][1])


def test_make_tui_argv_decodes_dev_prebuild_with_utf8_replace(
    tmp_path: Path, main_mod, monkeypatch
) -> None:
    ink_dir = tmp_path / "packages" / "hermes-ink"
    ink_dir.mkdir(parents=True)
    tsx = tmp_path / "node_modules" / ".bin" / "tsx"
    tsx.parent.mkdir(parents=True)
    tsx.write_text("")

    monkeypatch.setattr(main_mod, "_tui_need_pnpm_install", lambda _root: False)
    monkeypatch.setattr(main_mod.shutil, "which", lambda name: f"/bin/{name}")
    calls = []

    def fake_run(*args, **kwargs):
        calls.append((args, kwargs))
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(main_mod.subprocess, "run", fake_run)

    argv, cwd = main_mod._make_tui_argv(tmp_path, tui_dev=True)

    assert argv == [str(tsx), "src/entry.tsx"]
    assert cwd == tmp_path
    assert calls[0][0][0] == ["/bin/pnpm", "run", "build"]
    assert calls[0][1]["cwd"] == str(ink_dir)
    _assert_utf8_replace_capture(calls[0][1])


def test_make_tui_argv_uses_bundled_tui_when_workspace_missing(
    tmp_path: Path, main_mod, monkeypatch
) -> None:
    """Prebuilt-install regression (#56665): a prebuilt install (Docker
    image, Nix build, or prior `pnpm run build`) ships
    hermes_cli/tui_dist/entry.js but never ships ui-tui/ (that directory only
    exists in a git checkout). _make_tui_argv must try the bundled entry.js
    BEFORE _ensure_tui_workspace() — requiring the workspace first hard-exits
    every prebuilt dashboard Chat tab connection with `sys.exit(1)` (surfaced
    to the user as the unhelpful "Chat unavailable: 1") despite a perfectly
    runnable bundled TUI on disk. The bundled shortcut must succeed without
    ever touching the (missing) ui-tui workspace, pnpm, or git.
    """
    import hermes_constants

    monkeypatch.delenv("HERMES_TUI_DIR", raising=False)
    monkeypatch.setattr(main_mod, "_ensure_tui_node", lambda: None)

    bundled_entry = tmp_path / "bundled" / "entry.js"
    bundled_entry.parent.mkdir(parents=True)
    bundled_entry.write_text("// bundled TUI")
    monkeypatch.setattr(main_mod, "_find_bundled_tui", lambda: bundled_entry)

    def which(name: str) -> str | None:
        if name == "node":
            return "/usr/bin/node"
        raise AssertionError(f"unexpected shutil.which({name!r}) call — bundled path must not need pnpm/git")

    monkeypatch.setattr(main_mod.shutil, "which", which)

    def fail_pnpm():
        raise AssertionError("bundled TUI path must not resolve pnpm")

    monkeypatch.setattr(hermes_constants, "ensure_hermes_pnpm", fail_pnpm)

    def fail_run(*_args, **_kwargs):
        raise AssertionError("bundled TUI path must not spawn any subprocess (no pnpm install/build, no git restore)")

    monkeypatch.setattr(main_mod.subprocess, "run", fail_run)

    # ui-tui/ deliberately does not exist under tmp_path, and there is no
    # .git either — this mirrors a prebuilt (Docker/Nix) install exactly.
    tui_dir = tmp_path / "ui-tui"
    assert not tui_dir.exists()

    argv, cwd = main_mod._make_tui_argv(tui_dir, tui_dev=False)

    assert argv == ["/usr/bin/node", "--expose-gc", str(bundled_entry)]
    assert cwd == bundled_entry.parent


def test_make_tui_argv_exits_with_recovery_hint_when_workspace_unrecoverable(
    tmp_path: Path, main_mod, monkeypatch, capsys
) -> None:
    """Missing ui-tui + no bundle + no git checkout → clean error with the
    pnpm recovery steps, never touches node/pnpm."""
    monkeypatch.delenv("HERMES_TUI_DIR", raising=False)
    monkeypatch.setattr(main_mod, "_ensure_tui_node", lambda: None)
    monkeypatch.setattr(main_mod, "_find_bundled_tui", lambda: None)

    def fail_run(*_args, **_kwargs):
        raise AssertionError("an unrecoverable workspace must not spawn any subprocess")

    monkeypatch.setattr(main_mod.subprocess, "run", fail_run)

    with pytest.raises(SystemExit) as exc:
        main_mod._make_tui_argv(tmp_path / "ui-tui", tui_dev=False)

    assert exc.value.code == 1
    err = capsys.readouterr().err
    assert "git restore -- ui-tui" in err
    assert "Run `pnpm install`" in err


# ── _workspace_root helper ──────────────────────────────────────────


def test_workspace_root_is_nearest_ancestor_with_pnpm_workspace_yaml(
    tmp_path: Path, main_mod
) -> None:
    (tmp_path / "pnpm-workspace.yaml").write_text("packages:\n  - apps/*\n")
    member = tmp_path / "apps" / "desktop"
    member.mkdir(parents=True)
    (member / "package.json").write_text("{}")
    assert main_mod._workspace_root(member) == tmp_path


def test_workspace_root_is_dir_itself_with_own_lockfile(tmp_path: Path, main_mod) -> None:
    (tmp_path / "pnpm-workspace.yaml").write_text("packages:\n  - ui-tui\n")
    sub = tmp_path / "ui-tui"
    sub.mkdir()
    (sub / "package.json").write_text("{}")
    (sub / "pnpm-lock.yaml").write_text("")
    assert main_mod._workspace_root(sub) == sub


def test_workspace_root_is_dir_itself_without_workspace(tmp_path: Path, main_mod) -> None:
    sub = tmp_path / "ui-tui"
    sub.mkdir()
    (sub / "package.json").write_text("{}")
    # A parent lockfile alone does not make a workspace.
    (tmp_path / "pnpm-lock.yaml").write_text("")
    assert main_mod._workspace_root(sub) == sub


def test_pnpm_filter_args_select_dirs_with_their_workspace_deps(
    tmp_path: Path, main_mod
) -> None:
    args = main_mod._pnpm_filter_args(
        tmp_path, tmp_path / "ui-tui", tmp_path / "apps" / "web", tmp_path, Path("/elsewhere")
    )
    assert args == ("--filter", "{ui-tui}...", "--filter", "{apps/web}...")


def test_no_stray_lockfiles_in_workspace_subdirs(main_mod) -> None:
    """Workspace sub-directories must not contain their own pnpm-lock.yaml.

    With a single workspace root lockfile, per-directory lockfiles are
    always accidental (typically from running ``pnpm install
    --ignore-workspace`` inside a member).  They cause ``_workspace_root`` to
    treat the sub-package as standalone, which can silently diverge the
    install cwd from the lockfile-check root.

    This is an invariant, not a change-detector: the workspace structure
    is not expected to gain per-dir lockfiles.
    """
    root = main_mod.PROJECT_ROOT
    subdirs = [
        root / "ui-tui",
        root / "web",
        root / "apps" / "desktop",
        root / "apps" / "shared",
    ]
    # Also sweep ui-tui/packages/* (hermes-ink etc.)
    tui_pkgs = root / "ui-tui" / "packages"
    if tui_pkgs.is_dir():
        subdirs.extend(d for d in tui_pkgs.iterdir() if d.is_dir())

    stray = [d for d in subdirs if (d / "pnpm-lock.yaml").is_file()]
    assert not stray, (
        "stray pnpm-lock.yaml found in workspace sub-directory(es); "
        "delete them and run `pnpm install` from the repo root instead: "
        + ", ".join(str(d / "pnpm-lock.yaml") for d in stray)
    )


def test_make_tui_argv_omits_filter_and_scrubs_esbuild_override(
    tmp_path: Path, main_mod, monkeypatch
) -> None:
    """When ui-tui/ has its own pnpm-lock.yaml, _workspace_root returns
    tui_dir itself: there is no workspace to filter, so the install runs
    unfiltered from tui_dir.  See #42973. The pnpm child must also ignore an
    inherited esbuild binary override: a version mismatch makes esbuild's
    postinstall abort (#87405).
    """
    tui_dir = tmp_path / "ui-tui"
    tui_dir.mkdir()
    (tui_dir / "package.json").write_text("{}")
    # Simulate curl-install layout: tui_dir has its own lockfile
    (tui_dir / "pnpm-lock.yaml").write_text("")
    # Parent is a workspace too (but _workspace_root prefers tui_dir's own lockfile)
    (tmp_path / "pnpm-workspace.yaml").write_text("packages:\n  - ui-tui\n")
    (tmp_path / "pnpm-lock.yaml").write_text("")

    monkeypatch.delenv("TERMUX_VERSION", raising=False)
    monkeypatch.setenv("PREFIX", "/usr")
    monkeypatch.setenv("ESBUILD_BINARY_PATH", "/opt/esbuild-0.28.2")
    monkeypatch.setattr(main_mod, "_tui_need_pnpm_install", lambda _root: True)
    monkeypatch.setattr(main_mod.shutil, "which", lambda name: f"/bin/{name}")
    calls = []

    def fake_run(*args, **kwargs):
        calls.append((args, kwargs))
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(main_mod.subprocess, "run", fake_run)

    main_mod._make_tui_argv(tui_dir, tui_dev=False)

    install_cmd = calls[0][0][0]
    assert install_cmd == ["/bin/pnpm", "install", "--frozen-lockfile", "--prod=false"]
    # cwd must be tui_dir (standalone), not parent
    assert Path(calls[0][1]["cwd"]) == tui_dir
    assert "ESBUILD_BINARY_PATH" not in calls[0][1]["env"]
    # Old pnpm must report the engine mismatch, not try to switch versions.
    assert calls[0][1]["env"]["npm_config_manage_package_manager_versions"] == "false"
    assert calls[1][0][0][1:] == ["run", "build"]
    assert "ESBUILD_BINARY_PATH" not in calls[1][1]["env"]


def test_make_tui_argv_falls_back_to_no_lockfile_install(
    tmp_path: Path, main_mod, monkeypatch
) -> None:
    """An out-of-sync lockfile fails the frozen install; the launch retries
    without reading or writing the lockfile rather than rewriting it."""
    tui_dir = tmp_path / "ui-tui"
    tui_dir.mkdir()
    (tui_dir / "package.json").write_text("{}")
    (tui_dir / "pnpm-lock.yaml").write_text("")

    monkeypatch.delenv("TERMUX_VERSION", raising=False)
    monkeypatch.setenv("PREFIX", "/usr")
    monkeypatch.setattr(main_mod, "_tui_need_pnpm_install", lambda _root: True)
    monkeypatch.setattr(main_mod.shutil, "which", lambda name: f"/bin/{name}")
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        failed = "--frozen-lockfile" in cmd
        return types.SimpleNamespace(
            returncode=1 if failed else 0,
            stdout=" ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with \"frozen-lockfile\"" if failed else "",
            stderr="",
        )

    monkeypatch.setattr(main_mod.subprocess, "run", fake_run)

    main_mod._make_tui_argv(tui_dir, tui_dev=False)

    assert calls[:2] == [
        ["/bin/pnpm", "install", "--frozen-lockfile", "--prod=false"],
        ["/bin/pnpm", "install", "--no-lockfile", "--prod=false"],
    ]


def test_make_tui_argv_prints_pnpm_stdout_error_on_install_failure(
    tmp_path: Path, main_mod, monkeypatch, capsys
) -> None:
    """pnpm reports ERR_PNPM_* on stdout; the failure preview must show it."""
    tui_dir = tmp_path / "ui-tui"
    tui_dir.mkdir()
    (tui_dir / "package.json").write_text("{}")

    monkeypatch.delenv("TERMUX_VERSION", raising=False)
    monkeypatch.setenv("PREFIX", "/usr")
    monkeypatch.setattr(main_mod, "_tui_need_pnpm_install", lambda _root: True)
    monkeypatch.setattr(main_mod.shutil, "which", lambda name: f"/bin/{name}")
    monkeypatch.setattr(
        main_mod.subprocess,
        "run",
        lambda *_a, **_kw: types.SimpleNamespace(
            returncode=1, stdout=" ERR_PNPM_FETCH_404  GET https://x/foo: Not Found", stderr=""
        ),
    )

    with pytest.raises(SystemExit):
        main_mod._make_tui_argv(tui_dir, tui_dev=False)

    out = capsys.readouterr().out
    assert "pnpm install failed." in out
    assert "ERR_PNPM_FETCH_404" in out
