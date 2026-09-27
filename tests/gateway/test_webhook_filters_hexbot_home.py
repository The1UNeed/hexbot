"""`~/.hexbot/...` in a webhook route maps to the active home, like `~/.hermes/...`."""

from gateway.platforms import webhook_filters


def test_hexbot_tilde_maps_to_the_active_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / "scripts").mkdir()
    (tmp_path / "scripts" / "route.py").write_text("")

    assert webhook_filters._resolve_profile_path("~/.hexbot/scripts/route.py") == tmp_path / "scripts" / "route.py"
    path, error = webhook_filters._resolve_script_path("~/.hexbot/scripts/route.py")
    assert error is None and path == (tmp_path / "scripts" / "route.py").resolve()
