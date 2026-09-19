"""Tests for scripts/ci/lockfile_diff.py.

The differ's job is semantic comparison: reordering, integrity-hash and
snapshot churn in the lockfile text must produce an empty diff, while
actual version movement must show up as added/removed/updated regardless
of where in the file it appears.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

_PATH = Path(__file__).resolve().parents[2] / "scripts" / "ci" / "lockfile_diff.py"
_spec = importlib.util.spec_from_file_location("lockfile_diff", _PATH)
if _spec is None or _spec.loader is None:
    raise ImportError("Failed to load lockfile_diff.py")
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)


def _lock(packages: dict[str, str], snapshots: str = "") -> str:
    """A pnpm-lock.yaml with ``{name@version: integrity}`` as its packages."""
    entries = "".join(
        f"\n  {key if key[0] != '@' else repr(key)}:\n    resolution: {{integrity: {integrity}}}\n"
        for key, integrity in packages.items()
    )
    return (
        "lockfileVersion: '9.0'\n\n"
        "importers:\n\n  .:\n    dependencies:\n      react:\n"
        "        specifier: ^18.2.0\n        version: 18.2.0\n\n"
        f"packages:\n{entries}\n"
        f"snapshots:\n\n  ignored-snapshot@9.9.9: {{}}\n{snapshots}"
    )


BASE = _lock(
    {
        "react@18.2.0": "sha512-aaa",
        "react@17.0.2": "sha512-ccc",
        "left-pad@1.3.0": "sha512-bbb",
        "@scope/pkg@2.0.0": "sha512-ddd",
    }
)


def test_reorder_and_hash_churn_is_empty_diff():
    head = _lock(
        {
            "@scope/pkg@2.0.0": "sha512-zzz",
            "left-pad@1.3.0": "sha512-yyy",
            "react@17.0.2": "sha512-xxx",
            "react@18.2.0": "sha512-www",
        },
        snapshots="\n  react@18.2.0(peer@1.0.0): {}\n",
    )
    d = _mod.diff_locks(_mod.parse_lockfile(BASE), _mod.parse_lockfile(head))
    assert d == {"added": [], "removed": [], "updated": []}


def test_only_the_packages_map_is_read():
    parsed = _mod.parse_lockfile(BASE)
    assert parsed == {
        "react": {"18.2.0", "17.0.2"},
        "left-pad": {"1.3.0"},
        "@scope/pkg": {"2.0.0"},
    }


def test_add_remove_update_all_detected():
    head = _lock(
        {
            "react@18.3.1": "sha512-aaa",  # updated
            "is-even@1.0.0": "sha512-eee",  # added
            "react@17.0.2": "sha512-ccc",  # unchanged
            "@scope/pkg@2.0.0": "sha512-ddd",  # unchanged
            # left-pad removed
        }
    )
    d = _mod.diff_locks(_mod.parse_lockfile(BASE), _mod.parse_lockfile(head))
    assert d["added"] == [("is-even", "1.0.0")]
    assert d["removed"] == [("left-pad", "1.3.0")]
    assert d["updated"] == [("react", "18.2.0", "18.3.1")]


def test_second_locked_version_is_distinct_entry():
    # The same package locked at two versions must be tracked separately —
    # bumping only the older copy must not look like a change to the newer.
    head = _lock(
        {
            "react@18.2.0": "sha512-aaa",
            "react@17.0.3": "sha512-ccc",
            "left-pad@1.3.0": "sha512-bbb",
            "@scope/pkg@2.0.0": "sha512-ddd",
        }
    )
    d = _mod.diff_locks(_mod.parse_lockfile(BASE), _mod.parse_lockfile(head))
    assert d["updated"] == [("react", "17.0.2", "17.0.3")]
    assert d["added"] == [] and d["removed"] == []


def test_dropping_a_duplicate_version_is_a_removal():
    head = _lock(
        {
            "react@18.2.0": "sha512-aaa",
            "left-pad@1.3.0": "sha512-bbb",
            "@scope/pkg@2.0.0": "sha512-ddd",
        }
    )
    d = _mod.diff_locks(_mod.parse_lockfile(BASE), _mod.parse_lockfile(head))
    assert d == {"added": [], "removed": [("react", "17.0.2")], "updated": []}


def test_render_markdown_contains_versions():
    d = _mod.diff_locks(
        _mod.parse_lockfile(BASE),
        _mod.parse_lockfile(_lock({"react@19.0.0": "sha512-aaa", "react@17.0.2": "sha512-ccc"})),
    )
    md = _mod.render_markdown({"apps/desktop/pnpm-lock.yaml": d})
    # Fragment starts directly with the per-lockfile subsection header.
    assert md.startswith("#### `apps/desktop/pnpm-lock.yaml`")
    assert "| react | `18.2.0` | `19.0.0` |" in md
    assert "| ➖ @scope/pkg | `2.0.0` | — |" in md


def test_render_markdown_omits_unchanged_lockfiles():
    changed = _mod.diff_locks({}, {"x": {"1.0.0"}})
    unchanged = _mod.diff_locks({}, {})
    md = _mod.render_markdown({"a/pnpm-lock.yaml": changed, "b/pnpm-lock.yaml": unchanged})
    assert "a/pnpm-lock.yaml" in md
    assert "b/pnpm-lock.yaml" not in md
