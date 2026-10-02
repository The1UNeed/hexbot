import os
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

from hexbot import cli


def test_missing_marker_fails_and_sets_default_home(tmp_path, capsys):
    with patch.dict(os.environ, {"HOME": str(tmp_path)}, clear=True):
        assert cli.main(["version"]) == 1
        assert os.environ["HEXBOT_HOME"] == str(tmp_path / ".hexbot")
        assert os.environ["HERMES_HOME"] == str(tmp_path / ".hexbot")
        assert not (tmp_path / ".hexbot").exists()
    assert "service handoff unavailable" in capsys.readouterr().err


def test_explicit_home_expands_and_overrides_hermes_home(tmp_path):
    with patch.dict(os.environ, {"HOME": str(tmp_path), "HEXBOT_HOME": "~/service", "HERMES_HOME": "other"}):
        assert cli.main(["serve"]) == 1
        assert os.environ["HEXBOT_HOME"] == str(tmp_path / "service")
        assert os.environ["HERMES_HOME"] == str(tmp_path / "service")


def test_module_entry_point_without_marker_fails(tmp_path):
    result = subprocess.run([sys.executable, "-m", "hexbot.cli", "version"],
                            cwd=Path(cli.__file__).parents[1],
                            env={**os.environ, "HEXBOT_HOME": str(tmp_path)},
                            capture_output=True, text=True)
    assert result.returncode == 1
    assert result.stdout == ""
    assert "service handoff unavailable" in result.stderr


def test_serve_retries_the_install_until_handoff_replaces_the_process(tmp_path):
    calls, delays = [], []

    def handoff(arguments):
        calls.append(arguments)
        if len(calls) == 3:
            raise SystemExit(0)  # Stands in for os.execv into the native daemon.

    with patch.dict(os.environ, {"HEXBOT_HOME": str(tmp_path)}), \
            patch.object(cli, "handoff", handoff), patch.object(cli, "_has_marker", lambda: True):
        try:
            cli.main(["serve", "--port", "9119"], sleep=delays.append)
        except SystemExit as exit:
            assert exit.code == 0
    assert calls == [["serve", "--port", "9119"]] * 3
    assert delays == [cli.RETRY_FIRST, cli.RETRY_FIRST * 2]


def test_retry_delay_is_capped(tmp_path):
    delays = []

    def sleep(delay):
        delays.append(delay)
        if len(delays) == 10:
            raise KeyboardInterrupt

    with patch.dict(os.environ, {"HEXBOT_HOME": str(tmp_path)}), \
            patch.object(cli, "handoff", lambda arguments: None), patch.object(cli, "_has_marker", lambda: True):
        try:
            cli.main(["serve"], sleep=sleep)
        except KeyboardInterrupt:
            pass
    assert max(delays) == cli.RETRY_MAX


def test_version_never_retries(tmp_path):
    with patch.dict(os.environ, {"HEXBOT_HOME": str(tmp_path)}), \
            patch.object(cli, "handoff", lambda arguments: None), patch.object(cli, "_has_marker", lambda: True):
        assert cli.main(["version"], sleep=lambda delay: (_ for _ in ()).throw(AssertionError("slept"))) == 1
