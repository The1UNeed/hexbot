"""Recover from pnpm ``ERR_PNPM_UNSUPPORTED_ENGINE`` failures by upgrading a managed pnpm.

``pnpm-workspace.yaml`` sets ``engineStrict: true`` and the root
``package.json`` pins an ``engines.pnpm`` range, so a pnpm outside that range
aborts every ``pnpm install`` we run inside the checkout::

     ERR_PNPM_UNSUPPORTED_ENGINE  Unsupported environment (bad pnpm and/or Node.js version)

    Your pnpm version is incompatible with "/path/to/checkout".

    Expected version: >=10.16.0
    Got: 9.15.4

Rather than predicting the failure (which would mean a semver range matcher and
a ``pnpm --version`` probe before work that usually succeeds), we react to it:
pnpm says whether it or Node is the mismatch, and the recovery installs the
``packageManager`` pin from the root ``package.json``, which the repo's tests
keep inside ``engines.pnpm``.

Scope of the repair is deliberately narrow. Hermes only upgrades a pnpm that
lives inside its **own** managed Node tree (``$HERMES_HOME/node``), installing
in place with that tree's npm and ``--prefix``. A system / nvm / brew / Nix pnpm
belongs to the user and their other projects; Hermes never modifies those.
When the failing pnpm is one of those foreign installs, Hermes instead
provisions its own managed Node tree (the same tree a fresh install creates),
installs the pinned pnpm into *that*, and hands the caller the managed pnpm to
retry with — leaving the user's toolchain untouched.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

from hermes_constants import (
    bootstrap_hermes_managed_node,
    find_hermes_node_executable,
    get_hermes_home,
    install_managed_pnpm,
    managed_node_tree_in_use,
    pinned_pnpm_spec,
)

__all__ = [
    "is_unsupported_engine",
    "required_pnpm_range",
    "managed_pnpm_prefix",
    "upgrade_managed_pnpm",
    "maybe_repair_pnpm_engine",
]

# pnpm names the mismatched tool, then prints `Expected version:` / `Got:`.
# A Node mismatch says "Your Node version is incompatible" instead.
_PNPM_MISMATCH_RE = re.compile(
    r"Your pnpm version is incompatible.*?"
    r"Expected version:\s*(?P<range>[^\r\n]+)"
    r"(?:\s+Got:\s*(?P<actual>[^\r\n]+))?",
    re.DOTALL,
)


def is_unsupported_engine(output: str) -> bool:
    """Return True when *output* is a pnpm engine-compatibility failure."""
    return bool(output) and "ERR_PNPM_UNSUPPORTED_ENGINE" in output


def required_pnpm_range(output: str) -> str | None:
    """Return the ``engines.pnpm`` range pnpm demanded in *output*.

    Returns ``None`` when the output has no engine failure, or when the
    failure is about Node rather than pnpm — upgrading pnpm cannot fix a Node
    version mismatch, so the caller must not try.
    """
    if not is_unsupported_engine(output):
        return None
    match = _PNPM_MISMATCH_RE.search(output)
    return match.group("range").strip() if match else None


def actual_pnpm_version(output: str) -> str | None:
    """Return the pnpm version pnpm reported as ``Got`` in *output*."""
    match = _PNPM_MISMATCH_RE.search(output or "")
    actual = match.group("actual") if match else None
    return actual.strip() if actual else None


def managed_pnpm_prefix(pnpm: str | os.PathLike[str] | None) -> Path | None:
    """Return the Hermes-managed Node root *pnpm* lives in, else ``None``.

    Symlinks are resolved first: ``$HERMES_HOME/node/bin/pnpm`` links into
    ``lib/node_modules/pnpm/bin/pnpm.cjs``, and a user may link
    ``~/.local/bin/pnpm`` at it. Every one of those spellings is the managed
    pnpm and must be recognised as such, or the repair silently declines to
    fix the very install it owns.
    """
    if not pnpm:
        return None
    prefix = get_hermes_home() / "node"
    try:
        resolved = Path(pnpm).resolve()
        prefix_resolved = prefix.resolve()
    except OSError:
        return None
    if resolved == prefix_resolved or prefix_resolved in resolved.parents:
        return prefix
    return None


def upgrade_managed_pnpm(
    npm: str,
    pnpm_range: str | None,
    *,
    prefix: Path,
    quiet: bool = False,
) -> bool:
    """Install the pinned pnpm into the managed tree at *prefix* using *npm*.

    *npm* is the managed tree's own npm, the bootstrapper of pnpm.
    *pnpm_range* is the range pnpm asked for, used only to explain the
    upgrade; the version installed is always the ``packageManager`` pin.
    """
    spec = pinned_pnpm_spec()
    if not quiet:
        reason = f" to satisfy {pnpm_range}" if pnpm_range else ""
        print(f"→ Installing Hermes-managed {spec}{reason}…", flush=True)
    # The managed pnpm lives inside the very tree the desktop app's Node
    # processes execute from; an in-place upgrade while it is in use fails
    # with PermissionError: [WinError 5] on pnpm.cmd (#80926). Defer instead
    # of forcing the write — the upgrade re-triggers on the next resolution
    # (e.g. the next update once the app is closed).
    if managed_node_tree_in_use():
        if not quiet:
            print(
                "  ⚠ deferred: the Hermes-managed Node.js tree is in use by a "
                "running app; the pnpm upgrade will apply on a later update "
                "once the app is closed.",
                file=sys.stderr,
            )
        return False

    result = install_managed_pnpm(npm, prefix)
    if result is None:
        if not quiet:
            print("  ✗ pnpm install could not be started", file=sys.stderr)
        return False

    if result.returncode != 0:
        if not quiet:
            detail = (result.stderr or result.stdout or "").strip().splitlines()
            print("  ✗ pnpm install failed", file=sys.stderr)
            for line in detail[-10:]:
                print(f"    {line}", file=sys.stderr)
        return False

    if not quiet:
        print(f"  ✓ {spec} installed", flush=True)
    return True


def _print_manual_fix(pnpm: str, pnpm_range: str, actual: str | None) -> None:
    have = f"pnpm {actual} " if actual else "This pnpm "
    print(
        f"\n✗ {have}does not satisfy the range this project requires: {pnpm_range}\n"
        f"  Resolved pnpm: {pnpm}\n"
        "  Hermes could not provision its own Node.js runtime and never\n"
        "  modifies a system/nvm/brew/Nix pnpm. Upgrade yours yourself with:\n"
        f"      npm install -g {pinned_pnpm_spec()}",
        file=sys.stderr,
    )


def _provision_managed_pnpm(
    pnpm_range: str | None, *, quiet: bool = False
) -> str | None:
    """Provision a Hermes-managed Node tree and return its pinned pnpm.

    Installs the managed tree under ``$HERMES_HOME/node`` (reusing a healthy
    one when present), then installs the pinned pnpm into it — a fresh Node
    ships no pnpm at all. Returns the managed pnpm path, or ``None`` when
    provisioning failed.
    """
    if not quiet:
        print(
            "→ Provisioning a Hermes-managed Node.js runtime "
            "(the resolved pnpm belongs to your system and is left alone)…",
            flush=True,
        )
    managed_npm = bootstrap_hermes_managed_node()
    if not managed_npm:
        if not quiet:
            print("  ✗ Managed Node.js provisioning failed", file=sys.stderr)
        return None

    prefix = managed_pnpm_prefix(managed_npm)
    if prefix is None:  # pragma: no cover - bootstrap returned a foreign path
        return None

    if not upgrade_managed_pnpm(managed_npm, pnpm_range, prefix=prefix, quiet=quiet):
        return None
    return find_hermes_node_executable("pnpm")


def maybe_repair_pnpm_engine(
    pnpm: str | None,
    output: str,
    *,
    quiet: bool = False,
) -> str | None:
    """Repair an ``ERR_PNPM_UNSUPPORTED_ENGINE`` failure, never touching a foreign toolchain.

    *output* is the combined stdout/stderr of the pnpm command that just failed.
    Returns the pnpm executable the caller should retry its command with —
    the same *pnpm* after an in-place upgrade of a Hermes-managed install, or
    a freshly provisioned managed pnpm when the failing pnpm belongs to the
    user (system / nvm / brew / Nix installs are never modified). Returns
    ``None`` when no repair happened — not an engine failure, a Node mismatch
    a managed pnpm upgrade cannot fix, or a failed upgrade/bootstrap — leaving
    the original failure to stand.

    The returned value is truthy exactly when the caller should retry once,
    so ``if maybe_repair_pnpm_engine(...)`` call sites keep working; they just
    must run the retry with the returned path.
    """
    if not pnpm or not is_unsupported_engine(output):
        return None

    pnpm_range = required_pnpm_range(output)
    prefix = managed_pnpm_prefix(pnpm)

    if prefix is not None:
        # Hermes owns this pnpm — upgrade it in place. Only a pnpm-range
        # failure is fixable this way; a Node mismatch needs a Node upgrade.
        if not pnpm_range:
            return None
        npm = find_hermes_node_executable("npm")
        if npm and upgrade_managed_pnpm(npm, pnpm_range, prefix=prefix, quiet=quiet):
            return pnpm
        return None

    # Foreign pnpm (system / nvm / brew / Nix): provision our own runtime
    # instead. This also covers Node-version mismatches — the managed tree
    # ships a Node the repo supports.
    managed = _provision_managed_pnpm(pnpm_range, quiet=quiet)
    if managed:
        return managed

    if not quiet and pnpm_range:
        _print_manual_fix(pnpm, pnpm_range, actual_pnpm_version(output))
    return None
