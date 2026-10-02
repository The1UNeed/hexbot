"""Replays the legacy service updater against this package with real uv.

hexbot/update.py in installed Python daemons syncs the venv to the new source,
then runs the ``version`` probe, and never rolls back. A failed native install
must leave the previous daemon's environment in place.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

PACKAGE = Path(__file__).resolve().parents[1]
UV = shutil.which("uv")
pytestmark = pytest.mark.skipif(UV is None, reason="needs uv, like the legacy updater")

LEGACY_PYPROJECT = """[project]
name = "hermes-agent"
version = "0.0.1"
requires-python = ">=3.11"
dependencies = []

[project.optional-dependencies]
all = []

[project.scripts]
hexbot = "legacy_daemon:main"

[build-system]
requires = ["hatchling==1.27.0"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
only-include = ["legacy_daemon.py"]
"""


def sync(source, env):
    subprocess.run([UV, "sync", "--extra", "all", "--locked"], cwd=source, env=env, check=True,
                   capture_output=True, timeout=600)


def test_failed_native_install_keeps_the_legacy_daemon(tmp_path):
    home = tmp_path / "home"
    venv = home / "runtime/venv"
    legacy = home / "runtime/src/0.1.4"
    legacy.mkdir(parents=True)
    (legacy / "pyproject.toml").write_text(LEGACY_PYPROJECT)
    (legacy / "legacy_daemon.py").write_text("def main():\n    print('legacy daemon')\n")
    (legacy / "HEXBOT_BUILD.json").write_text(json.dumps({"date": "2026-09-01T00:00:00Z"}))
    subprocess.run([UV, "lock"], cwd=legacy, check=True, capture_output=True, timeout=600)
    subprocess.run([UV, "venv", str(venv), "--python", sys.executable], check=True, capture_output=True)
    env = {**os.environ, "HEXBOT_HOME": str(home), "UV_PROJECT_ENVIRONMENT": str(venv),
           "UV_PYTHON": str(venv / "bin/python"), "VIRTUAL_ENV": str(venv),
           # Nothing listens here, so the native download fails.
           "HEXBOT_UPDATE_URL": "https://127.0.0.1:9"}
    env.pop("PYTHONPATH", None)
    sync(legacy, env)
    hexbot = venv / "bin/hexbot"
    assert subprocess.run([hexbot], capture_output=True, text=True).stdout == "legacy daemon\n"

    # What the archive unpacks to, as staged by scripts/desktop/stage-python-src.mjs.
    source = home / "runtime/src/9.9.9"
    shutil.copytree(PACKAGE / "hexbot", source / "hexbot", ignore=shutil.ignore_patterns("__pycache__"))
    for name in ("pyproject.toml", "uv.lock"):
        shutil.copy(PACKAGE / name, source / name)
    (source / "HEXBOT_NATIVE_TRANSITION.json").write_text(json.dumps({"version": "9.9.9"}))
    sync(source, env)
    probe = subprocess.run([hexbot, "version"], env=env, capture_output=True, text=True, timeout=600)

    assert probe.returncode != 0
    assert probe.stdout == ""
    assert subprocess.run([hexbot], capture_output=True, text=True).stdout == "legacy daemon\n"
    assert not (home / "runtime/native-executable").exists()
