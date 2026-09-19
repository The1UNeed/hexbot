#!/usr/bin/env python3
"""Semantic diff of pnpm ``pnpm-lock.yaml`` files for PR comments.

``git diff`` on a lockfile is unreadable: integrity hashes, peer-dependency
suffixes in ``snapshots``, and per-importer specifiers all churn, so a
one-line ``package.json`` bump can produce a thousand-line textual diff.
This script ignores the text entirely — it reads the keys of the
``packages`` map (``name@version``) out of both versions of each lockfile
(lockfileVersion 9), reduces each to ``{name: versions}``, and set-diffs
the two dicts. Reordering and hash churn vanish; what's left is the actual
dependency change.

Usage (from a checkout that still has the base ref available):

    python scripts/ci/lockfile_diff.py --base <ref> --head <ref> \
        --output diff.md [--repo-root .]

Reads every ``pnpm-lock.yaml`` tracked at either ref (top-level and
nested — the repo has several), diffs each, and writes a Markdown fragment
to ``--output``. Exits 0 always; an empty output file means "no version
changes" (the caller uses that to decide whether to include the section).
The fragment is consumed by ``scripts/ci/assemble_review_comment.py``,
which wraps it in a section with a header and action note.
"""

from __future__ import annotations

import argparse
import subprocess
import sys


def parse_lockfile(text: str) -> dict[str, set[str]]:
    """Reduce lockfile YAML to ``{package name: {versions}}``.

    Only the keys of the top-level ``packages`` map are read: one
    ``name@version`` per line at two-space indent, quoted when the name is
    scoped. That is a fixed, machine-written shape, so it is matched by
    line rather than with a YAML parser (CI runs this without the project
    venv). One package locked at two versions yields two versions under
    one name.
    """
    out: dict[str, set[str]] = {}
    in_packages = False
    for line in text.splitlines():
        if not line.strip():
            continue
        if not line.startswith(" "):
            in_packages = line.rstrip() == "packages:"
            continue
        if not in_packages or line.startswith("   ") or not line.startswith("  "):
            continue
        key = line.strip().split(": ", 1)[0].rstrip(":").strip("'\"")
        name, sep, version = key.rpartition("@")
        if sep and name:
            out.setdefault(name, set()).add(version)
    return out


def diff_locks(base: dict[str, set[str]], head: dict[str, set[str]]) -> dict[str, list]:
    """Set-diff two ``{name: versions}`` maps.

    Returns ``added`` / ``removed`` as ``[(name, version)]`` and
    ``updated`` as ``[(name, base_version, head_version)]``, each sorted.
    A name that loses one version and gains another is an update; versions
    gained or lost beyond that pairing are additions or removals.
    """
    added, removed, updated = [], [], []
    for name in sorted(base.keys() | head.keys()):
        gone = sorted(base.get(name, set()) - head.get(name, set()))
        new = sorted(head.get(name, set()) - base.get(name, set()))
        paired = min(len(gone), len(new))
        updated += [(name, old, cur) for old, cur in zip(gone, new)]
        added += [(name, v) for v in new[paired:]]
        removed += [(name, v) for v in gone[paired:]]
    return {"added": added, "removed": removed, "updated": updated}


def render_markdown(diffs: dict[str, dict[str, list]]) -> str:
    """Render per-lockfile diffs as a Markdown fragment.

    ``diffs`` maps lockfile repo-path → the output of :func:`diff_locks`.
    Lockfiles with no version changes are omitted. Returns ``""`` when
    nothing changed anywhere (caller skips the section entirely).

    The output is a fragment — per-lockfile ``####`` subsections with
    tables — not a standalone comment. The ``assemble_review_comment``
    script wraps this in a section with its own header and action note,
    so no top-level header or comment marker is emitted here.
    """
    sections = []
    for lockfile, d in sorted(diffs.items()):
        added, removed, updated = d["added"], d["removed"], d["updated"]
        n = len(added) + len(removed) + len(updated)
        if n == 0:
            continue
        lines = [f"#### `{lockfile}`", ""]
        lines.append("| Package | Before | After |")
        lines.append("| --- | --- | --- |")
        for name, old, new in updated:
            lines.append(f"| {name} | `{old}` | `{new}` |")
        for name, version in added:
            lines.append(f"| ➕ {name} | — | `{version}` |")
        for name, version in removed:
            lines.append(f"| ➖ {name} | `{version}` | — |")
        sections.append("\n".join(lines))

    if not sections:
        return ""

    return "\n\n".join(sections) + "\n"


def _git_show(ref: str, path: str, repo_root: str) -> str | None:
    """Contents of ``path`` at ``ref``, or None if it doesn't exist there."""
    proc = subprocess.run(
        ["git", "show", f"{ref}:{path}"],
        capture_output=True,
        text=True, encoding="utf-8", errors="replace",
        cwd=repo_root,
    )
    return proc.stdout if proc.returncode == 0 else None


def _tracked_lockfiles(ref: str, repo_root: str) -> set[str]:
    proc = subprocess.run(
        ["git", "ls-tree", "-r", "--name-only", ref],
        capture_output=True,
        text=True, encoding="utf-8", errors="replace",
        cwd=repo_root,
        check=True,
    )
    return {
        line
        for line in proc.stdout.splitlines()
        if line.split("/")[-1] == "pnpm-lock.yaml"
    }


def diff_refs(base: str, head: str, repo_root: str = ".") -> dict[str, dict[str, list]]:
    """Diff every pnpm-lock.yaml tracked at either ref."""
    lockfiles = _tracked_lockfiles(base, repo_root) | _tracked_lockfiles(head, repo_root)
    diffs = {}
    for path in sorted(lockfiles):
        base_text = _git_show(base, path, repo_root)
        head_text = _git_show(head, path, repo_root)
        base_map = parse_lockfile(base_text) if base_text else {}
        head_map = parse_lockfile(head_text) if head_text else {}
        diffs[path] = diff_locks(base_map, head_map)
    return diffs


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base", required=True, help="base git ref (merge base)")
    ap.add_argument("--head", required=True, help="head git ref")
    ap.add_argument("--output", required=True, help="markdown output path")
    ap.add_argument("--repo-root", default=".", help="repository root")
    args = ap.parse_args()

    diffs = diff_refs(args.base, args.head, args.repo_root)
    markdown = render_markdown(diffs)
    with open(args.output, "w", encoding="utf-8") as fh:
        fh.write(markdown)

    if markdown:
        changed = sum(len(v) for d in diffs.values() for v in d.values())
        print(f"{changed} package version change(s) — report written to {args.output}")
    else:
        print("No package version changes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
