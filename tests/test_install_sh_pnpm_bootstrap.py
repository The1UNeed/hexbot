"""The installers make the pinned pnpm available without touching a Node they
do not own.

A pnpm already on PATH is reused when it satisfies ``engines.pnpm``. Otherwise
npm installs the ``packageManager`` pin under ``$HERMES_HOME/node`` with an
explicit ``--prefix``, so nothing lands in a system, nvm, or Homebrew Node.

These run the real ``ensure_pnpm`` (``scripts/install.sh``) and
``_nb_ensure_pnpm`` (``scripts/lib/node-bootstrap.sh``) against stub ``npm``
and ``pnpm`` executables.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALL_SH = REPO_ROOT / "scripts" / "install.sh"
NODE_BOOTSTRAP = REPO_ROOT / "scripts" / "lib" / "node-bootstrap.sh"

PIN = json.loads((REPO_ROOT / "package.json").read_text())["packageManager"]
PIN_VERSION = PIN.removeprefix("pnpm@").split("+")[0]

pytestmark = pytest.mark.skipif(shutil.which("bash") is None, reason="needs bash")

# Records its arguments, then drops a pnpm reporting the pin under --prefix.
NPM_STUB = f"""#!/bin/sh
printf '%s\\n' "$*" >> "$NPM_CALLS"
printf '%s\\n' "$PWD" >> "$NPM_CALLS.cwd"
[ -n "${{NPM_FAIL:-}}" ] && exit 1
while [ $# -gt 0 ]; do
    [ "$1" = "--prefix" ] && prefix="$2"
    shift
done
mkdir -p "$prefix/bin"
printf '#!/bin/sh\\necho {PIN_VERSION}\\n' > "$prefix/bin/pnpm"
chmod +x "$prefix/bin/pnpm"
"""


def _write_executable(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    path.chmod(0o755)


def _pnpm_stub(version: str) -> str:
    return f"#!/bin/sh\necho {version}\n"


def _checkout(tmp_path: Path) -> Path:
    """A checkout carrying the real manifest and node-bootstrap.sh."""
    checkout = tmp_path / "checkout"
    (checkout / "scripts" / "lib").mkdir(parents=True)
    shutil.copy(REPO_ROOT / "package.json", checkout / "package.json")
    shutil.copy(NODE_BOOTSTRAP, checkout / "scripts" / "lib" / "node-bootstrap.sh")
    return checkout


def _run(tmp_path: Path, script: str, **extra_env: str) -> subprocess.CompletedProcess[str]:
    env = {
        "HOME": str(tmp_path / "user-home"),
        "HERMES_HOME": str(tmp_path / "hermes-home"),
        "NPM_CALLS": str(tmp_path / "npm-calls"),
        "PATH": f"{tmp_path / 'bin'}:/usr/bin:/bin",
        **extra_env,
    }
    (tmp_path / "bin").mkdir(exist_ok=True)
    return subprocess.run(
        ["bash", "-c", script], env=env, capture_output=True, text=True, check=False
    )


def _install_sh_script(checkout: Path) -> str:
    return (
        f'source "{INSTALL_SH}" --manifest >/dev/null\n'
        f'INSTALL_DIR="{checkout}"\n'
        "ensure_pnpm || exit 1\n"
        'printf "%s %s\\n" "$(command -v pnpm)" "$(pnpm --version)"\n'
    )


def _npm_calls(tmp_path: Path) -> list[str]:
    calls = tmp_path / "npm-calls"
    return calls.read_text().splitlines() if calls.exists() else []


def test_install_sh_reuses_a_pnpm_that_satisfies_engines(tmp_path: Path) -> None:
    _write_executable(tmp_path / "bin" / "npm", NPM_STUB)
    _write_executable(tmp_path / "bin" / "pnpm", _pnpm_stub(PIN_VERSION))

    proc = _run(tmp_path, _install_sh_script(_checkout(tmp_path)))

    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.splitlines()[-1] == f"{tmp_path / 'bin' / 'pnpm'} {PIN_VERSION}"
    assert _npm_calls(tmp_path) == []


def test_install_sh_installs_the_pin_into_the_managed_prefix(tmp_path: Path) -> None:
    """A too-old pnpm on PATH is neither used nor upgraded in place."""
    _write_executable(tmp_path / "bin" / "npm", NPM_STUB)
    _write_executable(tmp_path / "bin" / "pnpm", _pnpm_stub("9.15.0"))
    checkout = _checkout(tmp_path)

    proc = _run(tmp_path, _install_sh_script(checkout))

    assert proc.returncode == 0, proc.stderr
    managed_prefix = tmp_path / "hermes-home" / "node"
    assert _npm_calls(tmp_path) == [
        f"install -g --prefix {managed_prefix} --no-fund --no-audit "
        f"--progress=false {PIN}"
    ]
    # Run from a scratch directory, never from the checkout or the caller's cwd.
    npm_cwd = Path((tmp_path / "npm-calls.cwd").read_text().strip())
    assert checkout not in (npm_cwd, *npm_cwd.parents)
    assert not npm_cwd.exists()
    # The pinned pnpm now wins on PATH, and only pnpm was added to it: the
    # managed bin dir itself stays off PATH.
    resolved, version = proc.stdout.splitlines()[-1].split()
    assert version == PIN_VERSION
    assert Path(resolved).resolve() == (managed_prefix / "bin" / "pnpm").resolve()
    assert sorted(p.name for p in Path(resolved).parent.iterdir()) == ["pnpm"]
    assert (tmp_path / "bin" / "pnpm").read_text() == _pnpm_stub("9.15.0")


def test_install_sh_reuses_a_managed_pnpm_from_an_earlier_run(tmp_path: Path) -> None:
    _write_executable(tmp_path / "bin" / "npm", NPM_STUB)
    managed_pnpm = tmp_path / "hermes-home" / "node" / "bin" / "pnpm"
    _write_executable(managed_pnpm, _pnpm_stub(PIN_VERSION))

    proc = _run(tmp_path, _install_sh_script(_checkout(tmp_path)))

    assert proc.returncode == 0, proc.stderr
    assert _npm_calls(tmp_path) == []
    assert proc.stdout.splitlines()[-1].endswith(f"/pnpm {PIN_VERSION}")


def test_install_sh_fails_when_pnpm_cannot_be_installed(tmp_path: Path) -> None:
    _write_executable(tmp_path / "bin" / "npm", NPM_STUB)

    proc = _run(tmp_path, _install_sh_script(_checkout(tmp_path)), NPM_FAIL="1")

    assert proc.returncode == 1
    assert "pnpm install failed or timed out" in proc.stderr + proc.stdout


@pytest.mark.parametrize(
    ("version", "accepted"),
    [
        ("10.16.0", True),
        (PIN_VERSION, True),
        ("11.0.0", True),
        ("10.15.9", False),
        ("9.15.0", False),
        ("10.16.0-rc.1", False),
        ("", False),
    ],
)
@pytest.mark.parametrize("flavor", ["install.sh", "node-bootstrap.sh"])
def test_engines_pnpm_gate(tmp_path: Path, flavor: str, version: str, accepted: bool) -> None:
    """Both scripts read the floor from ``engines.pnpm`` (>=10.16.0)."""
    checkout = _checkout(tmp_path)
    if flavor == "install.sh":
        script = (
            f'source "{INSTALL_SH}" --manifest >/dev/null\n'
            f'INSTALL_DIR="{checkout}"\n'
            f'pnpm_satisfies_engines "{version}"\n'
        )
    else:
        script = (
            f'source "{checkout}/scripts/lib/node-bootstrap.sh"\n'
            f'_nb_pnpm_version_ok "{version}"\n'
        )

    assert (_run(tmp_path, script).returncode == 0) is accepted


def test_node_bootstrap_installs_the_pin_with_the_managed_npm(tmp_path: Path) -> None:
    managed_prefix = tmp_path / "hermes-home" / "node"
    _write_executable(managed_prefix / "bin" / "npm", NPM_STUB)
    checkout = _checkout(tmp_path)

    proc = _run(
        tmp_path,
        f'source "{checkout}/scripts/lib/node-bootstrap.sh"\n_nb_ensure_pnpm\n',
    )

    assert proc.returncode == 0, proc.stderr
    assert _npm_calls(tmp_path) == [
        f"install --global --prefix {managed_prefix} {PIN} --no-fund --no-audit "
        "--progress=false"
    ]
    assert (managed_prefix / "bin" / "pnpm").is_file()


def test_node_bootstrap_never_installs_with_a_foreign_npm(tmp_path: Path) -> None:
    """With no managed tree, the npm on PATH belongs to the user."""
    _write_executable(tmp_path / "bin" / "npm", NPM_STUB)
    checkout = _checkout(tmp_path)

    proc = _run(
        tmp_path,
        f'source "{checkout}/scripts/lib/node-bootstrap.sh"\n_nb_ensure_pnpm\n',
    )

    assert proc.returncode == 0, proc.stderr
    assert _npm_calls(tmp_path) == []


def test_node_bootstrap_reuses_a_pnpm_that_satisfies_engines(tmp_path: Path) -> None:
    _write_executable(tmp_path / "hermes-home" / "node" / "bin" / "npm", NPM_STUB)
    _write_executable(tmp_path / "bin" / "pnpm", _pnpm_stub(PIN_VERSION))
    checkout = _checkout(tmp_path)

    proc = _run(
        tmp_path,
        f'source "{checkout}/scripts/lib/node-bootstrap.sh"\n_nb_ensure_pnpm\n',
    )

    assert proc.returncode == 0, proc.stderr
    assert _npm_calls(tmp_path) == []
