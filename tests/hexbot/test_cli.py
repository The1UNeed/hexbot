import os
import sys

import pytest


@pytest.mark.parametrize("name", ["core", "hermes"])
def test_core_passthrough_and_hidden_alias(name, monkeypatch):
    from hexbot import cli

    seen = []
    monkeypatch.setattr("hermes_cli.main.main", lambda: seen.append(list(sys.argv)) or 0)

    assert cli.main([name, "doctor", "--fix"]) == 0
    assert seen == [["hermes", "doctor", "--fix"]]


def test_hermes_alias_is_hidden_from_help():
    from hexbot import cli

    help_text = cli.parser().format_help()
    assert "core" in help_text and "hermes" not in help_text


def test_core_keeps_a_profile_home_inside_the_hexbot_home(tmp_path, monkeypatch):
    from hexbot import cli

    profile = tmp_path / "profiles" / "scout"
    profile.mkdir(parents=True)
    monkeypatch.setenv("HEXBOT_HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(profile))
    homes = []
    monkeypatch.setattr("hermes_cli.main.main", lambda: homes.append(os.environ["HERMES_HOME"]) or 0)

    cli.main(["core", "status"])
    monkeypatch.setenv("HERMES_HOME", str(tmp_path.parent / ".hermes"))
    cli.main(["core", "status"])

    assert homes == [str(profile), str(tmp_path)]


def test_core_keeps_a_container_home_when_no_hexbot_home_is_set(tmp_path, monkeypatch):
    from hexbot import cli

    monkeypatch.delenv("HEXBOT_HOME", raising=False)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "data"))
    homes = []
    monkeypatch.setattr("hermes_cli.main.main", lambda: homes.append(os.environ["HERMES_HOME"]) or 0)

    cli.main(["core", "pairing", "list"])

    assert homes == [str(tmp_path / "data")]
