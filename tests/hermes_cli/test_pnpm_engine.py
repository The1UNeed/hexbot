"""Tests for pnpm ``ERR_PNPM_UNSUPPORTED_ENGINE`` recovery (``hermes_cli/pnpm_engine.py``).

The behaviour under test is a contract about *reacting* to pnpm's own engine
check: pnpm states which tool is out of range, Hexbot upgrades only a pnpm it
owns (to the ``packageManager`` pin), and every other case leaves the original
failure alone.
"""

import subprocess
from pathlib import Path

import pytest

import hermes_cli.pnpm_engine as pnpm_engine
from hermes_cli.pnpm_engine import (
    actual_pnpm_version,
    is_unsupported_engine,
    managed_pnpm_prefix,
    maybe_repair_pnpm_engine,
    required_pnpm_range,
)
from hermes_constants import pinned_pnpm_spec


# Verbatim pnpm 10 output for an engines.pnpm mismatch.
UNSUPPORTED_ENGINE_OUTPUT = """
\u2009ERR_PNPM_UNSUPPORTED_ENGINE\u2009 Unsupported environment (bad pnpm and/or Node.js version)

Your pnpm version is incompatible with "/home/u/.hermes/hermes-agent".

Expected version: >=10.16.0
Got: 9.15.4

This is happening because the package's manifest has an engines.pnpm field specified.
To fix this issue, install the required pnpm version globally.

To install the latest version of pnpm, run "pnpm i -g pnpm".
To check your pnpm version, run "pnpm -v".
"""

# The same error code when Node, not pnpm, is out of range.
NODE_ONLY_OUTPUT = """
\u2009ERR_PNPM_UNSUPPORTED_ENGINE\u2009 Unsupported environment (bad pnpm and/or Node.js version)

Your Node version is incompatible with "/home/u/.hermes/hermes-agent".

Expected version: ^22.22.0 || ^24.11.0 || >=26.0.0
Got: v18.0.0

This is happening because the package's manifest has an engines.node field specified.
To fix this issue, install the required Node version.
"""

# A lockfile mismatch — the other common frozen-install failure. Must NOT be
# treated as an engine problem, or every out-of-sync lockfile would trigger an
# upgrade.
ELOCK_OUTPUT = """
\u2009ERR_PNPM_OUTDATED_LOCKFILE\u2009 Cannot install with "frozen-lockfile" because
pnpm-lock.yaml is not up to date with package.json
"""


class TestDetection:
    def test_recognises_engine_failures(self):
        assert is_unsupported_engine(UNSUPPORTED_ENGINE_OUTPUT)
        assert is_unsupported_engine(NODE_ONLY_OUTPUT)

    def test_unrelated_failures_are_not_engine_failures(self):
        assert not is_unsupported_engine(ELOCK_OUTPUT)
        assert not is_unsupported_engine("")
        assert not is_unsupported_engine("ERR_PNPM_FETCH_404")

    def test_range_comes_from_the_error_not_a_hardcoded_list(self):
        assert required_pnpm_range(UNSUPPORTED_ENGINE_OUTPUT) == ">=10.16.0"

    def test_actual_version_is_reported_back(self):
        assert actual_pnpm_version(UNSUPPORTED_ENGINE_OUTPUT) == "9.15.4"

    def test_no_range_for_non_engine_output(self):
        assert required_pnpm_range(ELOCK_OUTPUT) is None
        assert required_pnpm_range("") is None

    def test_node_only_mismatch_yields_no_pnpm_range(self):
        """Upgrading pnpm cannot fix a Node version mismatch, so don't try."""
        assert required_pnpm_range(NODE_ONLY_OUTPUT) is None
        assert actual_pnpm_version(NODE_ONLY_OUTPUT) is None

    def test_engine_code_without_a_mismatch_block_is_ignored(self):
        assert required_pnpm_range("ERR_PNPM_UNSUPPORTED_ENGINE\n") is None


class TestManagedDetection:
    """The upgrade must fire for every spelling of the managed pnpm, and for
    no other pnpm — this is the boundary between "Hexbot fixes it" and "the
    user's own toolchain is left alone"."""

    @pytest.fixture
    def managed_tree(self, tmp_path, monkeypatch):
        home = tmp_path / ".hermes"
        node = home / "node"
        (node / "bin").mkdir(parents=True)
        (node / "lib" / "node_modules" / "pnpm" / "bin").mkdir(parents=True)
        cli = node / "lib" / "node_modules" / "pnpm" / "bin" / "pnpm.cjs"
        cli.write_text("#!/usr/bin/env node\n", encoding="utf-8")
        (node / "bin" / "pnpm").symlink_to(cli)
        monkeypatch.setenv("HERMES_HOME", str(home))
        return home

    def test_direct_managed_bin_is_managed(self, managed_tree):
        pnpm = managed_tree / "node" / "bin" / "pnpm"
        assert managed_pnpm_prefix(pnpm) == managed_tree / "node"

    def test_symlink_from_local_bin_resolves_to_managed(self, managed_tree, tmp_path):
        """A ~/.local/bin/pnpm link at the managed tree is the pnpm a user's
        PATH actually resolves, so it must count as managed."""
        local_bin = tmp_path / "local-bin"
        local_bin.mkdir()
        link = local_bin / "pnpm"
        link.symlink_to(managed_tree / "node" / "bin" / "pnpm")
        assert managed_pnpm_prefix(link) == managed_tree / "node"

    def test_system_pnpm_is_not_managed(self, managed_tree, tmp_path):
        system_pnpm = tmp_path / "usr" / "bin" / "pnpm"
        system_pnpm.parent.mkdir(parents=True)
        system_pnpm.write_text("#!/bin/sh\n", encoding="utf-8")
        assert managed_pnpm_prefix(system_pnpm) is None

    def test_no_pnpm_is_not_managed(self, managed_tree):
        assert managed_pnpm_prefix(None) is None
        assert managed_pnpm_prefix("") is None


@pytest.fixture
def managed_pnpm(tmp_path, monkeypatch):
    """A managed tree holding npm and pnpm stubs, resolved without probing."""
    home = tmp_path / ".hermes"
    bin_dir = home / "node" / "bin"
    bin_dir.mkdir(parents=True)
    for name in ("npm", "pnpm"):
        tool = bin_dir / name
        tool.write_text("#!/bin/sh\n", encoding="utf-8")
        tool.chmod(0o755)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(
        pnpm_engine,
        "find_hermes_node_executable",
        lambda command: str(bin_dir / command),
    )
    return bin_dir / "pnpm"


class TestInUseDeferral:
    """The managed tree cannot be written while a running app executes from
    it (WinError 5 on pnpm.cmd, #80926) — the pnpm upgrade defers instead."""

    def test_in_use_managed_tree_defers_upgrade_without_running_npm(
        self, managed_pnpm, monkeypatch
    ):
        monkeypatch.setattr(pnpm_engine, "managed_node_tree_in_use", lambda: True)

        def forbidden_run(cmd, **kwargs):
            raise AssertionError(f"npm must not run while the tree is in use: {cmd}")

        monkeypatch.setattr(subprocess, "run", forbidden_run)

        result = pnpm_engine.upgrade_managed_pnpm(
            str(managed_pnpm.parent / "npm"),
            ">=10.16.0",
            prefix=managed_pnpm.parent.parent,
            quiet=True,
        )
        assert result is False

    def test_in_use_deferral_blocks_repair_retry(self, managed_pnpm, monkeypatch):
        """End-to-end: an in-use tree means no npm subprocess runs and no
        retry is offered — the original engine failure stands with the
        deferral notice."""
        monkeypatch.setattr(pnpm_engine, "managed_node_tree_in_use", lambda: True)

        def forbidden_run(cmd, **kwargs):
            raise AssertionError(f"npm must not run while the tree is in use: {cmd}")

        monkeypatch.setattr(subprocess, "run", forbidden_run)

        assert (
            maybe_repair_pnpm_engine(
                str(managed_pnpm), UNSUPPORTED_ENGINE_OUTPUT, quiet=True
            )
            is None
        )


class TestRepairDecision:
    """`maybe_repair_pnpm_engine` returns the pnpm to retry with (truthy) only
    when a repair actually happened, because its return value is what gates
    the caller's single retry."""

    def test_upgrades_managed_pnpm_to_the_pin_with_the_managed_npm(
        self, managed_pnpm, monkeypatch
    ):
        calls = []

        def fake_run(cmd, **kwargs):
            calls.append((cmd, kwargs))
            return subprocess.CompletedProcess(cmd, 0, "", "")

        monkeypatch.setattr(subprocess, "run", fake_run)
        repaired = maybe_repair_pnpm_engine(
            str(managed_pnpm), UNSUPPORTED_ENGINE_OUTPUT, quiet=True
        )
        assert repaired == str(managed_pnpm)

        upgrade_cmd = calls[0][0]
        # npm bootstraps pnpm: the managed npm runs the install, not pnpm.
        assert upgrade_cmd[0] == str(managed_pnpm.parent / "npm")
        assert upgrade_cmd[1:3] == ["install", "--global"]
        # The version is the packageManager pin, and the install targets the
        # managed prefix explicitly (the managed etc/npmrc points `prefix`
        # elsewhere).
        assert pinned_pnpm_spec() in upgrade_cmd
        prefix_index = upgrade_cmd.index("--prefix")
        assert Path(upgrade_cmd[prefix_index + 1]) == managed_pnpm.parent.parent

    def test_upgrade_runs_outside_the_checkout(self, managed_pnpm, monkeypatch):
        """Project-level npm config must not apply to the pnpm install, and a
        user-level min-release-age must not gate the exact pin."""
        seen = {}

        def fake_run(cmd, **kwargs):
            seen.update(kwargs)
            return subprocess.CompletedProcess(cmd, 0, "", "")

        monkeypatch.setattr(subprocess, "run", fake_run)
        maybe_repair_pnpm_engine(
            str(managed_pnpm), UNSUPPORTED_ENGINE_OUTPUT, quiet=True
        )

        cwd = Path(seen["cwd"])
        repo_root = Path(__file__).resolve().parents[2]
        assert repo_root != cwd and repo_root not in cwd.parents
        assert seen["env"]["npm_config_min_release_age"] == "0"

    def test_failed_upgrade_reports_no_retry(self, managed_pnpm, monkeypatch):
        monkeypatch.setattr(
            subprocess,
            "run",
            lambda cmd, **kw: subprocess.CompletedProcess(cmd, 1, "", "boom"),
        )
        assert not maybe_repair_pnpm_engine(
            str(managed_pnpm), UNSUPPORTED_ENGINE_OUTPUT, quiet=True
        )

    def test_managed_pnpm_without_a_managed_npm_reports_no_retry(
        self, managed_pnpm, monkeypatch
    ):
        monkeypatch.setattr(
            pnpm_engine, "find_hermes_node_executable", lambda command: None
        )

        def explode(cmd, **kwargs):  # pragma: no cover - must not be reached
            raise AssertionError("nothing can install pnpm without the managed npm")

        monkeypatch.setattr(subprocess, "run", explode)
        assert not maybe_repair_pnpm_engine(
            str(managed_pnpm), UNSUPPORTED_ENGINE_OUTPUT, quiet=True
        )

    @pytest.mark.parametrize(
        "output, expected_range",
        [(UNSUPPORTED_ENGINE_OUTPUT, ">=10.16.0"), (NODE_ONLY_OUTPUT, None)],
        ids=["pnpm-mismatch", "node-only-mismatch"],
    )
    def test_foreign_pnpm_provisions_managed_runtime_instead(
        self, tmp_path, monkeypatch, output, expected_range
    ):
        """A system/nvm/brew/Nix pnpm is never modified — Hexbot provisions its
        own managed tree, installs the pinned pnpm into THAT, and returns it.
        A too-old system Node is covered the same way: the managed tree ships a
        supported Node."""
        home = tmp_path / ".hermes"
        monkeypatch.setenv("HERMES_HOME", str(home))
        system_pnpm = tmp_path / "usr-bin-pnpm"
        system_pnpm.write_text("#!/bin/sh\n", encoding="utf-8")

        managed_npm = home / "node" / "bin" / "npm"
        managed = home / "node" / "bin" / "pnpm"

        def fake_bootstrap():
            managed_npm.parent.mkdir(parents=True, exist_ok=True)
            managed_npm.write_text("#!/bin/sh\n", encoding="utf-8")
            managed_npm.chmod(0o755)
            return str(managed_npm)

        upgrades = []

        def fake_upgrade(npm, rng, *, prefix, quiet=False):
            upgrades.append((npm, rng, prefix))
            return True

        monkeypatch.setattr(
            pnpm_engine, "bootstrap_hermes_managed_node", fake_bootstrap
        )
        monkeypatch.setattr(pnpm_engine, "upgrade_managed_pnpm", fake_upgrade)
        monkeypatch.setattr(
            pnpm_engine,
            "find_hermes_node_executable",
            lambda command: str(managed) if command == "pnpm" else None,
        )

        repaired = maybe_repair_pnpm_engine(str(system_pnpm), output, quiet=True)
        assert repaired == str(managed)
        # The install ran with the MANAGED npm into the managed prefix — the
        # system pnpm was never the target of anything.
        assert upgrades == [(str(managed_npm), expected_range, home / "node")]

    def test_foreign_pnpm_failed_bootstrap_prints_manual_fix(
        self, tmp_path, monkeypatch, capsys
    ):
        home = tmp_path / ".hermes"
        monkeypatch.setenv("HERMES_HOME", str(home))
        system_pnpm = tmp_path / "usr-bin-pnpm"
        system_pnpm.write_text("#!/bin/sh\n", encoding="utf-8")

        monkeypatch.setattr(
            pnpm_engine, "bootstrap_hermes_managed_node", lambda: None
        )
        assert not maybe_repair_pnpm_engine(
            str(system_pnpm), UNSUPPORTED_ENGINE_OUTPUT
        )

        # The user gets the exact command to run, since we refuse to run it.
        err = capsys.readouterr().err
        assert f"npm install -g {pinned_pnpm_spec()}" in err
        assert "pnpm 9.15.4" in err and ">=10.16.0" in err

    def test_non_engine_failure_never_repairs(self, managed_pnpm, monkeypatch):
        def explode(cmd, **kwargs):  # pragma: no cover - must not be reached
            raise AssertionError("a lockfile mismatch must not trigger a repair")

        monkeypatch.setattr(subprocess, "run", explode)
        assert not maybe_repair_pnpm_engine(
            str(managed_pnpm), ELOCK_OUTPUT, quiet=True
        )

    def test_node_only_mismatch_on_managed_pnpm_does_not_upgrade(
        self, managed_pnpm, monkeypatch
    ):
        """Upgrading a managed pnpm cannot fix a managed-Node mismatch."""

        def explode(cmd, **kwargs):  # pragma: no cover - must not be reached
            raise AssertionError("pnpm upgrade cannot fix a Node mismatch")

        monkeypatch.setattr(subprocess, "run", explode)
        assert not maybe_repair_pnpm_engine(
            str(managed_pnpm), NODE_ONLY_OUTPUT, quiet=True
        )
