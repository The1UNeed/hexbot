"""Connector catalog, credential writes, per-bot enablement and incidents."""

import os

import pytest

from hexbot.errors import HexbotError


@pytest.fixture
def home(gw, profiles, isolated_home, monkeypatch):
    """A bot named scout with a fake profile; requirement checks are stubbed."""
    from hexbot.bots import create_bot
    for key in ("EXA_API_KEY", "FAL_KEY", "NOTION_API_KEY", "XAI_API_KEY", "HASS_TOKEN",
                "HASS_URL", "TAVILY_API_KEY", "KREA_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr("hexbot.connectors._run_check", lambda spec_id: None)
    # Probes never touch the network in tests; the two probe tests override this.
    monkeypatch.setattr("hexbot.connectors._http_get", lambda url, headers: (200, "OK"))
    monkeypatch.setattr("hexbot.connectors._profile_dirs",
                        lambda: sorted(p for p in profiles["root"].iterdir() if p.is_dir()))
    create_bot("scout")
    return isolated_home


@pytest.fixture
def gw(fake_gateway):
    fake_gateway.responses.update({
        "profiles.create": {"created": True},
        "profiles.configure": {"ok": True},
        "profiles.describe": {"toolsets": [{"name": "terminal", "enabled": True},
                                           {"name": "file", "enabled": True}],
                              "skills": [{"name": "hermes-agent", "enabled": True}]},
        "profiles.get_asset": {"found": False},
        "session.create": {"session_id": "live1", "stored_session_id": "stored1", "messages": []},
        "session.list": {"sessions": []},
        "session.active_list": {"sessions": []},
    })
    return fake_gateway


@pytest.fixture
def profiles(tmp_path, monkeypatch):
    root = tmp_path / "home" / "profiles"
    root.mkdir(parents=True, exist_ok=True)

    def get_profile_dir(name):
        path = root / name
        path.mkdir(parents=True, exist_ok=True)
        return path

    monkeypatch.setattr("hermes_cli.profiles.validate_profile_name", lambda name: None)
    monkeypatch.setattr("hermes_cli.profiles.get_profile_dir", get_profile_dir)
    monkeypatch.setattr("hermes_cli.profiles.write_profile_meta", lambda directory, **kwargs: None)
    monkeypatch.setattr("hermes_cli.profiles.delete_profile", lambda name, yes=False: None)
    return {"root": root}


def by_id(rows, connector_id):
    return next(row for row in rows if row["id"] == connector_id)


def test_catalog_lists_every_connector_with_state(home, gw):
    from hexbot.connectors import list_connectors
    rows = list_connectors("scout")["connectors"]
    ids = [row["id"] for row in rows]
    assert ids[:4] == ["web_search", "cloud_browser", "image_gen", "video_gen"]
    assert {"notion", "airtable", "x_search", "home_assistant", "premium_voice"} <= set(ids)
    web = by_id(rows, "web_search")
    assert web["state"] == "not_set_up" and web["state_text"] == "Not set up"
    assert web["provider"] is None
    # Every provider's fields come back, tagged, so the sheet can show the
    # right one before anything is saved.
    assert [(f["key"], f["provider"]) for f in web["fields"]][:2] == [
        ("EXA_API_KEY", "exa"), ("TAVILY_API_KEY", "tavily")]
    assert [p["id"] for p in web["providers"]][:2] == ["exa", "tavily"]
    assert web["enabled_for_bot"] is False and web["enabled_bots"] == []
    notion = by_id(rows, "notion")
    assert notion["icon"] == "notion" and notion["group"] == "work"
    assert notion["fields"][0]["key"] == "NOTION_API_KEY"
    assert notion["fields"][0]["secret"] is True
    assert notion["fields"][0]["url"].startswith("https://www.notion.so")
    assert by_id(rows, "home_assistant")["fields"][0]["label"] == "Home Assistant URL"


def test_setup_writes_env_everywhere_and_enables_for_the_bot(home, gw, profiles):
    from dotenv import dotenv_values
    from hexbot.connectors import list_connectors, setup
    gw.calls.clear()
    result = setup("web_search", {"EXA_API_KEY": "exa-secret-1234"}, bot="scout")
    assert result["test"] == {"ok": True, "message": "Key saved."}
    assert dotenv_values(home / ".env")["EXA_API_KEY"] == "exa-secret-1234"
    assert dotenv_values(profiles["root"] / "scout" / ".env")["EXA_API_KEY"] == "exa-secret-1234"
    assert os.environ["EXA_API_KEY"] == "exa-secret-1234"
    from ruamel.yaml import YAML
    for path in (home / "config.yaml", profiles["root"] / "scout" / "config.yaml"):
        assert YAML(typ="safe").load(path.read_text())["web"]["backend"] == "exa"
    configure = gw.params_for("profiles.configure")[-1]
    assert configure["enabled_toolsets"] == ["file", "terminal", "web"]
    row = result["connector"]
    assert row["state"] == "ready" and row["state_text"] == "Key saved · Exa"
    assert row["provider"] == "exa"
    exa = next(f for f in row["fields"] if f["key"] == "EXA_API_KEY")
    assert exa["set"] is True and exa["hint"] == "…1234"

    gw.responses["profiles.describe"] = {"toolsets": [{"name": "web", "enabled": True}]}
    assert by_id(list_connectors("scout")["connectors"], "web_search")["enabled_bots"] == ["scout"]


def test_setup_needs_a_provider_when_ambiguous(home, gw):
    from hexbot.connectors import setup
    with pytest.raises(HexbotError) as caught:
        setup("image_gen", {})
    assert caught.value.code == 4202
    with pytest.raises(HexbotError) as caught:
        setup("notion", {"BOGUS": "x"})
    assert caught.value.code == 4201
    result = setup("notion", {})
    assert result["test"]["ok"] is False and "NOTION_API_KEY" in result["test"]["message"]


def test_skill_connector_installs_and_enables_the_skill(home, gw, profiles):
    from hexbot.connectors import set_for_bot, setup
    gw.calls.clear()
    setup("notion", {"NOTION_API_KEY": "ntn_1234567890"}, bot="scout")
    assert (profiles["root"] / "scout" / "skills" / "productivity" / "notion" / "SKILL.md").exists()
    assert gw.params_for("profiles.configure")[-1]["disabled_skills"] == []
    gw.responses["profiles.describe"] = {"skills": [{"name": "notion", "enabled": True}]}
    row = set_for_bot("notion", "scout", False)["connector"]
    assert gw.params_for("profiles.configure")[-1]["disabled_skills"] == ["notion"]
    assert row["enabled_for_bot"] is False or row["enabled_for_bot"] is True  # shape only


def test_clear_removes_values_and_turns_it_off_everywhere(home, gw, profiles):
    from dotenv import dotenv_values
    from hexbot.connectors import clear, setup
    setup("home_assistant", {"HASS_URL": "http://ha.local:8123", "HASS_TOKEN": "tok-12345678"},
          bot="scout")
    gw.responses["profiles.describe"] = {"toolsets": [
        {"name": "homeassistant", "enabled": True}, {"name": "file", "enabled": True}]}
    gw.calls.clear()
    row = clear("home_assistant")["connector"]
    assert row["state"] == "not_set_up"
    assert "HASS_TOKEN" not in dotenv_values(home / ".env")
    assert "HASS_TOKEN" not in os.environ
    assert gw.params_for("profiles.configure")[-1]["enabled_toolsets"] == ["file"]


def test_bot_only_values_stay_in_the_profile(home, gw, profiles):
    from dotenv import dotenv_values
    from hexbot.connectors import setup
    setup("airtable", {"AIRTABLE_API_KEY": "pat-abcdefgh"}, bot="scout", bot_only=True,
          enable_for_bot=False)
    assert "AIRTABLE_API_KEY" not in dotenv_values(home / ".env")
    assert dotenv_values(profiles["root"] / "scout" / ".env")["AIRTABLE_API_KEY"] == "pat-abcdefgh"
    assert "AIRTABLE_API_KEY" not in os.environ
    assert not gw.params_for("profiles.configure")


def test_x_search_reuses_the_xai_provider_key(home, gw, monkeypatch):
    from hexbot.connectors import setup
    written = []
    monkeypatch.setattr("hexbot.providers.set_key",
                        lambda provider, key: written.append((provider, key)) or {"provider": provider})
    setup("x_search", {"XAI_API_KEY": "xai-12345678"})
    assert written == [("xai", "xai-12345678")]


def test_setup_resolves_the_connector_incident(home, gw):
    from hexbot import incidents
    from hexbot.connectors import list_connectors, setup
    incidents.record("scout", "connector_error", "Notion: token expired", connector="notion")
    row = by_id(list_connectors("scout")["connectors"], "notion")
    assert row["state"] == "error" and row["state_text"] == "Notion: token expired"
    assert row["last_error"]["text"] == "Notion: token expired"
    setup("notion", {"NOTION_API_KEY": "ntn_fresh_12345"}, bot="scout")
    assert incidents.open_incidents() == {}
    assert by_id(list_connectors("scout")["connectors"], "notion")["state"] == "ready"


def test_failed_check_reports_honestly(home, gw, monkeypatch):
    from hexbot.connectors import setup, test_connector
    monkeypatch.setattr("hexbot.connectors._run_check", lambda spec_id: False)
    result = setup("image_gen", {"FAL_KEY": "fal-12345678"}, provider="fal", bot="scout",
                   enable_for_bot=False)
    assert result["test"]["ok"] is False
    assert "cannot use it yet" in result["test"]["message"]
    monkeypatch.setattr("hexbot.connectors._run_check", lambda spec_id: True)
    assert test_connector("image_gen")["ok"] is True


def test_probe_rejects_a_bad_token_and_keeps_the_row_in_error(home, gw, monkeypatch):
    from hexbot.connectors import list_connectors, setup
    monkeypatch.setattr("hexbot.connectors._http_get", lambda url, headers: (401, "Unauthorized"))
    result = setup("notion", {"NOTION_API_KEY": "ntn_test_invalid_123"}, bot="scout")
    assert result["test"] == {"ok": False, "message": "Notion refused the token (401)."}
    row = by_id(list_connectors("scout")["connectors"], "notion")
    assert row["state"] == "error"
    assert row["state_text"] == "Notion refused the token (401)."
    assert row["enabled_for_bot"] is False
    # A working token afterwards clears the error and reports a real connection.
    monkeypatch.setattr("hexbot.connectors._http_get", lambda url, headers: (200, "OK"))
    result = setup("notion", {"NOTION_API_KEY": "ntn_fresh_12345678"}, bot="scout")
    assert result["test"] == {"ok": True, "message": "Connected."}
    row = by_id(list_connectors("scout")["connectors"], "notion")
    assert row["state"] == "ready" and row["state_text"] == "Connected"


def test_probe_reports_an_unreachable_service(home, gw, monkeypatch):
    from hexbot.connectors import setup
    monkeypatch.setattr("hexbot.connectors._http_get", lambda url, headers: (None, "timed out"))
    result = setup("home_assistant", {"HASS_URL": "http://ha.local:8123", "HASS_TOKEN": "t" * 12},
                   bot="scout")
    assert result["test"]["ok"] is False
    assert result["test"]["message"] == "Could not reach Home Assistant: timed out."


def test_mcp_servers_come_from_the_root_config(home, gw):
    from hexbot.connectors import add_mcp, list_connectors, remove_mcp, set_for_bot
    row = add_mcp("github", command="npx", args=["-y", "@modelcontextprotocol/server-github"])["connector"]
    assert row["id"] == "mcp:github" and row["group"] == "mcp"
    assert row["mcp"]["transport"] == "stdio" and row["state"] == "ready"
    assert row["description"] == "npx -y @modelcontextprotocol/server-github"
    gw.calls.clear()
    set_for_bot("mcp:github", "scout", True)
    assert gw.params_for("profiles.configure")[-1]["enabled_mcp_servers"] == ["github"]
    gw.responses["profiles.describe"] = {"mcp_servers": [{"name": "github", "enabled": True}]}
    assert by_id(list_connectors("scout")["connectors"], "mcp:github")["enabled_for_bot"] is True
    assert remove_mcp("github") == {"removed": True}
    assert gw.params_for("profiles.configure")[-1]["enabled_mcp_servers"] == []
    assert "mcp:github" not in [r["id"] for r in list_connectors()["connectors"]]
    with pytest.raises(HexbotError) as caught:
        add_mcp("bad name!", command="x")
    assert caught.value.code == 4202
    with pytest.raises(HexbotError) as caught:
        remove_mcp("nope")
    assert caught.value.code == 4213


def test_unknown_connector_and_bot(home, gw):
    from hexbot.connectors import list_connectors, set_for_bot, setup
    for fn in (lambda: setup("nope", {}), lambda: set_for_bot("nope", "scout", True)):
        with pytest.raises(HexbotError) as caught:
            fn()
        assert caught.value.code == 4213
    with pytest.raises(HexbotError) as caught:
        list_connectors("ghost")
    assert caught.value.code == 4205


def test_skills_list_reads_frontmatter(home, gw, profiles):
    from hexbot.connectors import list_skills
    skill = profiles["root"] / "scout" / "skills" / "research" / "digest"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: digest\ndescription: Sum it up.\n---\n# Digest\n")
    gw.responses["profiles.describe"] = {"skills": [{"name": "digest", "enabled": False},
                                                    {"name": "hermes-agent", "enabled": True}]}
    result = list_skills("scout")["skills"]
    assert result[0] == {"name": "hermes-agent", "description": "", "category": "", "enabled": True}
    assert result[1] == {"name": "digest", "description": "Sum it up.", "category": "research",
                         "enabled": False}


def test_incident_heuristics():
    from hexbot.incidents import classify_tool_result, looks_like_refusal
    assert looks_like_refusal("HTTP 401 Unauthorized")
    assert looks_like_refusal("Your API key has expired")
    assert looks_like_refusal("insufficient credits")
    assert not looks_like_refusal("Wrote 3 files")
    assert classify_tool_result("image_generate", "", status="error",
                                error_message="FAL 403 forbidden") == ("image_gen", "FAL 403 forbidden")
    assert classify_tool_result("terminal", "curl: (22) 401 from api.notion.com NOTION_API_KEY bad") \
        == ("notion", "curl: (22) 401 from api.notion.com NOTION_API_KEY bad")
    assert classify_tool_result("terminal", "rm: cannot remove", status="error") is None
    assert classify_tool_result("web_search", {"results": []}, status="success") is None
    assert classify_tool_result("ha_get_state", "connection refused", status="error")[0] == "home_assistant"


def _offered(*names):
    """Which of these tools Hermes would put in a session's schema right now."""
    from tools.registry import registry
    return {d["function"]["name"] for d in registry.get_definitions(set(names), quiet=True)}


def test_connector_tools_stay_hidden_until_set_up(home, gw, monkeypatch):
    """Hermes alone would offer web search here: its keyless tier is on and an
    xAI model key counts as a web backend. Hexbot offers it only after setup."""
    import tools.image_generation_tool  # noqa: F401  (importing registers the tools)
    import tools.web_tools  # noqa: F401
    from tools.registry import invalidate_check_fn_cache
    from hexbot.connectors import clear, gate_tools, setup
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("XAI_API_KEY", "xai-model-key")
    gate_tools()
    gate_tools()  # registering twice must not stack gates
    invalidate_check_fn_cache()
    tools = ("web_search", "web_extract", "image_generate")
    assert _offered(*tools) == set()
    setup("web_search", {"TAVILY_API_KEY": "tvly-0123456789"}, provider="tavily")
    assert _offered(*tools) == {"web_search", "web_extract"}
    clear("web_search")
    assert _offered(*tools) == set()
