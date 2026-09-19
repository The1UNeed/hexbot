"""The manifest's ``engines`` must be satisfiable by a toolchain we can actually ship.

`engineStrict: true` in `pnpm-workspace.yaml` makes `engines` a hard gate on
every `pnpm install` — the installer's workspace step, `hermes update`'s
dependency refresh, and CI alike. So a floor nobody's toolchain can meet is
not a strict-hygiene win; it is a total install outage.

Node bundles no pnpm, so the pnpm every install ends up with is the one
Hermes bootstraps: the `packageManager` pin. If that pin falls outside
`engines.pnpm`, every fresh install dies at the first `pnpm install` and the
engine recovery in `hermes_cli/pnpm_engine.py` reinstalls the same rejected
version. These tests encode the invariants that catch it.

Deliberately behavioral, not a snapshot: nothing here pins a version we
expect to change. Each test asserts a *relationship* — between the floor we
declare and the toolchain that has to satisfy it.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]


def _root_manifest() -> dict:
    return json.loads((REPO_ROOT / "package.json").read_text())


def _workspace_config() -> dict:
    return yaml.safe_load((REPO_ROOT / "pnpm-workspace.yaml").read_text())


def _pinned_pnpm_version() -> str:
    name, _, version = _root_manifest()["packageManager"].partition("@")
    assert name == "pnpm" and version, "packageManager must pin pnpm@X.Y.Z"
    return version.split("+", 1)[0]


def _parse_major_minor_patch(version: str) -> tuple[int, int, int]:
    parts = version.split("-", 1)[0].split(".")
    nums = [int(p) for p in parts[:3]]
    while len(nums) < 3:
        nums.append(0)
    return nums[0], nums[1], nums[2]


def _satisfies_clause(version: str, clause: str) -> bool:
    """Evaluate one `>=x.y.z` / `<x.y.z` / `^x.y.z` comparator against *version*."""
    clause = clause.strip()
    if clause.startswith("^"):
        bound = clause[1:].strip()
        have = _parse_major_minor_patch(version)
        want = _parse_major_minor_patch(bound)
        # ^x.y.z allows >=x.y.z within the same major (x > 0).
        return have[0] == want[0] and have >= want
    for op in (">=", "<=", "<", ">", "="):
        if clause.startswith(op):
            bound = clause[len(op) :].strip()
            break
    else:
        op, bound = "=", clause
    have = _parse_major_minor_patch(version)
    want = _parse_major_minor_patch(bound)
    if op == ">=":
        return have >= want
    if op == "<=":
        return have <= want
    if op == "<":
        return have < want
    if op == ">":
        return have > want
    return have == want


def _satisfies_range(version: str, spec: str) -> bool:
    """Evaluate the `A || B` / space-joined-AND subset of semver we author."""
    for alternative in spec.split("||"):
        clauses = [c for c in alternative.strip().split() if c]
        if clauses and all(_satisfies_clause(version, c) for c in clauses):
            return True
    return False


class TestEnginesAreSatisfiable:
    def test_pnpm_floor_is_met_by_the_pinned_pnpm(self):
        """The pnpm Hermes bootstraps must be one our floor accepts.

        Without this, a fresh install cannot run `pnpm install` at all: the
        installer puts `pnpm@<packageManager pin>` into the managed Node tree
        and immediately uses it.
        """
        pnpm_range = _root_manifest()["engines"]["pnpm"]
        pinned = _pinned_pnpm_version()
        assert _satisfies_range(pinned, pnpm_range), (
            f"engines.pnpm is {pnpm_range!r}, which rejects the packageManager "
            f"pin pnpm@{pinned}. With engineStrict every fresh install fails "
            "at the first `pnpm install`."
        )

    def test_engines_are_a_hard_gate(self):
        """The invariants here only matter while pnpm enforces `engines`."""
        assert _workspace_config().get("engineStrict") is True, (
            "pnpm-workspace.yaml must set engineStrict: true so an "
            "unsupported Node or pnpm fails the install instead of producing "
            "a tree that breaks later."
        )

    def test_node_floor_is_met_by_the_managed_runtime(self):
        """The Node major the installers provision must clear engines.node."""
        node_range = _root_manifest()["engines"]["node"]
        install_sh = (REPO_ROOT / "scripts" / "install.sh").read_text()
        for line in install_sh.splitlines():
            if line.startswith("NODE_VERSION="):
                managed_major = int(line.split("=", 1)[1].strip().strip('"').strip("'"))
                break
        else:  # pragma: no cover - install.sh always defines it
            pytest.fail("install.sh does not define NODE_VERSION")

        # install.sh fetches latest-v{major}.x, not {major}.0.0. Use a high
        # representative release from that major so ranges that enumerate LTS
        # lines (rather than one continuous floor) are checked correctly.
        managed_release = f"{managed_major}.999.999"
        assert _satisfies_range(managed_release, node_range), (
            f"engines.node is {node_range!r} but install.sh provisions Node "
            f"{managed_major}.x. The runtime we ship must satisfy the floor we "
            "declare, or the install we just performed cannot install deps."
        )

    def test_desktop_node_floor_is_not_stricter_than_its_toolchain(self):
        """apps/desktop must not demand more Node than its own build tools do.

        Vite is the real constraint (it needs `node:util.styleText`). Raising
        the desktop floor beyond it silently force-migrates every user's
        toolchain for no dependency reason.
        """
        desktop = json.loads((REPO_ROOT / "apps" / "desktop" / "package.json").read_text())
        node_range = desktop["engines"]["node"]
        # The tightest floor any dependency actually declares (react-router
        # 8.3.0 -> >=22.22.0). If this legitimately rises, the assertion
        # documents the reason for the bump rather than blocking it.
        assert _satisfies_range("22.22.0", node_range), (
            f"apps/desktop engines.node is {node_range!r}, which rejects Node "
            "22.12 — stricter than Vite requires. A desktop floor above the "
            "build toolchain's own floor replaces working user toolchains for "
            "nothing."
        )


class TestPnpmHonorsTheReleaseAgeGate:
    """pnpm older than 10.16 silently ignores `minimumReleaseAge`.

    `pnpm-workspace.yaml` sets it (and `minimumReleaseAgeExclude`), so an
    older pnpm would install freshly published releases the gate exists to
    refuse. The floor must keep excluding them.
    """

    @pytest.mark.parametrize("bad_pnpm", ["9.15.4", "10.0.0", "10.15.1"])
    def test_pnpm_that_ignores_the_gate_is_rejected(self, bad_pnpm):
        if "minimumReleaseAge" not in _workspace_config():
            pytest.skip("pnpm-workspace.yaml does not set minimumReleaseAge")
        pnpm_range = _root_manifest()["engines"]["pnpm"]
        assert not _satisfies_range(bad_pnpm, pnpm_range), (
            f"engines.pnpm {pnpm_range!r} accepts pnpm {bad_pnpm}, which "
            "ignores minimumReleaseAge in pnpm-workspace.yaml."
        )

    @pytest.mark.parametrize("good_pnpm", ["10.16.0", "10.29.3", "11.0.0"])
    def test_pnpm_that_honors_the_gate_is_accepted(self, good_pnpm):
        pnpm_range = _root_manifest()["engines"]["pnpm"]
        assert _satisfies_range(good_pnpm, pnpm_range), (
            f"engines.pnpm {pnpm_range!r} rejects pnpm {good_pnpm}, which "
            "handles pnpm-workspace.yaml correctly and should be usable."
        )


def _normalize_range(spec: str) -> str:
    """Normalize the wilder styles real deps publish so our tiny evaluator
    can read them: collapse space after operators (``">= 10"``), drop ``v``
    prefixes (``">=v12.22.7"``), and rewrite ``x``/``*`` wildcards to floors.
    """
    import re

    spec = re.sub(r"(>=|<=|>|<|\^|~|=)\s+", r"\1", spec)
    spec = re.sub(r"(>=|<=|>|<|\^|~|=)v", r"\1", spec)
    # "6.x" / "10.*" -> "^6.0.0"-ish floor within the major; ">= 10.*" -> ">=10.0.0"
    spec = re.sub(r"(\d+)\.[x*](?:\.[x*])?", r"\1.0.0", spec)
    return spec


class TestDeclaredFloorsClearTheLockedTree:
    """Every Node version our own gates accept must survive `pnpm install`.

    The class of outage this pins: the installers' version gates
    (node_satisfies_build in install.sh, Test-NodeVersionOk in install.ps1)
    and `engines.node` are hand-maintained, while the *real* floor is
    whatever the strictest locked dependency demands. When they drift, a
    user's system Node clears every gate we own and then dies at
    `pnpm install` with ERR_PNPM_UNSUPPORTED_ENGINE under engineStrict.

    Aug 2026 instance: @babel/* 8.x requires `^22.18.0 || >=24.11.0`; our
    engines arm said `^24.0.0`, so Node 24.4 passed the installer and the
    manifest and failed on 28 babel packages.
    """

    def _arm_floors(self, node_range: str) -> list[str]:
        floors = []
        for arm in node_range.split("||"):
            arm = arm.strip()
            for op in ("^", ">=", "="):
                if arm.startswith(op):
                    floors.append(arm[len(op):].strip())
                    break
            else:
                floors.append(arm)
        return floors

    def _locked_node_ranges(self) -> dict[str, str]:
        lock = yaml.safe_load((REPO_ROOT / "pnpm-lock.yaml").read_text())
        # pnpm skips an optional package whose engines reject the running
        # Node (platform binaries mostly); only required ones fail the install.
        required = {
            key.split("(", 1)[0]
            for key, snapshot in lock["snapshots"].items()
            if not snapshot.get("optional")
        }
        ranges: dict[str, str] = {}
        for path, meta in lock["packages"].items():
            if path not in required:
                continue
            engines = meta.get("engines")
            if not isinstance(engines, dict):
                continue
            node_range = engines.get("node")
            if isinstance(node_range, str) and node_range.strip() not in ("", "*"):
                ranges.setdefault(node_range, path)
        return ranges

    def test_every_engines_arm_floor_clears_every_locked_dependency(self):
        node_range = _root_manifest()["engines"]["node"]
        violations = []
        for floor in self._arm_floors(node_range):
            for dep_range, example in self._locked_node_ranges().items():
                if not _satisfies_range(floor, _normalize_range(dep_range)):
                    violations.append((floor, dep_range, example))
        assert not violations, (
            "engines.node arms admit Node versions the locked dependency "
            "tree rejects — those users pass every install gate and then "
            "die at `pnpm install` with ERR_PNPM_UNSUPPORTED_ENGINE "
            "(engineStrict). "
            "Raise the arm floor (and the installer gates: "
            "node_satisfies_build in scripts/install.sh, Test-NodeVersionOk "
            f"in scripts/install.ps1) or relax the dep. Violations: {violations}"
        )

    def test_installer_gates_match_the_manifest_arms(self):
        """install.sh's node_satisfies_build must encode the same floors as
        engines.node — a laxer gate accepts a Node that pnpm then rejects."""
        node_range = _root_manifest()["engines"]["node"]
        install_sh = (REPO_ROOT / "scripts" / "install.sh").read_text()
        install_ps1 = (REPO_ROOT / "scripts" / "install.ps1").read_text()
        for arm in node_range.split("||"):
            arm = arm.strip()
            major, minor = _parse_major_minor_patch(arm.lstrip("^>="))[:2]
            if arm.startswith("^") and minor > 0:
                sh_gate = f'[ "$major" -eq {major} ] && [ "$minor" -ge {minor} ]'
                ps1_gate = f"if ($v.Major -eq {major}) {{ return ($v.Minor -ge {minor}) }}"
                assert sh_gate in install_sh, (
                    f"engines.node arm {arm!r} has no matching gate in "
                    f"install.sh node_satisfies_build (expected: {sh_gate})"
                )
                assert ps1_gate in install_ps1, (
                    f"engines.node arm {arm!r} has no matching gate in "
                    f"install.ps1 Test-NodeVersionOk (expected: {ps1_gate})"
                )

