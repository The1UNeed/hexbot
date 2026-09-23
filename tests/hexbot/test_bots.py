"""Bot lifecycle against a fake gateway and fake profile helpers."""

import pytest

from hexbot.errors import GatewayError, HexbotError


@pytest.fixture
def profiles(tmp_path, monkeypatch):
    """Fake hermes_cli.profiles so no real profile directory is created."""
    root = tmp_path / "profiles"
    deleted = []

    def get_profile_dir(name):
        path = root / name
        path.mkdir(parents=True, exist_ok=True)
        return path

    monkeypatch.setattr("hermes_cli.profiles.validate_profile_name", lambda name: None)
    monkeypatch.setattr("hermes_cli.profiles.get_profile_dir", get_profile_dir)
    monkeypatch.setattr("hermes_cli.profiles.write_profile_meta",
                        lambda directory, **kwargs: meta.append((directory, kwargs)))
    monkeypatch.setattr("hermes_cli.profiles.delete_profile",
                        lambda name, yes=False: deleted.append(name))
    meta: list = []
    root.mkdir(parents=True, exist_ok=True)
    return {"root": root, "meta": meta, "deleted": deleted}


@pytest.fixture
def gw(fake_gateway):
    state = {"n": 0}

    def create_session(params):
        state["n"] += 1
        return {"session_id": f"live{state['n']}",
                "stored_session_id": f"stored{state['n']}", "messages": []}

    fake_gateway.responses.update({
        "profiles.create": {"created": True},
        "profiles.configure": {"ok": True},
        "profiles.describe": {"description": "Research", "soul": "Careful",
                              "model": {"provider": "openai-codex", "default": "gpt-5.6-sol"}},
        "profiles.get_asset": {"found": False},
        "session.create": create_session,
        "session.list": {"sessions": []},
        "session.active_list": {"sessions": []},
    })
    return fake_gateway


def test_create_bot_mirrors_credentials_and_settings(gw, profiles, isolated_home):
    from hexbot.bots import create_bot
    from hexbot.settings import update_settings

    update_settings({"approval_mode": "smart"})
    bot, section = create_bot("scout", title="Research scout", description="Research",
                              persona="Careful", provider="openai-codex", model="gpt-5.6-sol")

    assert bot["name"] == "scout"
    assert bot["title"] == "Research scout"
    assert bot["provider"] == "openai-codex"
    assert bot["model"] == "gpt-5.6-sol"
    assert section["title"] == "General"
    assert bot["sections_total"] == 1
    assert [item["id"] for item in bot["sections_recent"]] == [section["id"]]

    from hexbot.bots import get_bot
    from hexbot.sections import create_section
    create_section("scout", "Dreams")
    assert [item["id"] for item in get_bot("scout")["sections_recent"]] == [section["id"]]

    params = gw.params_for("profiles.create")[0]
    assert params["mirror_credentials"] is True
    assert params["soul"] == "Careful"
    assert params["model"] == "gpt-5.6-sol"

    # The deployment settings mirror ran against the new profile.
    from ruamel.yaml import YAML
    config = (profiles["root"] / "scout" / "config.yaml").read_text()
    assert YAML(typ="safe").load(config)["approvals"]["mode"] == "smart"


def test_display_name_defaults_to_title_case_not_title(gw, profiles):
    from hexbot.bots import create_bot, default_display_name

    assert default_display_name("research_scout") == "Research Scout"
    bot, _ = create_bot("research-scout", title="Some free-form title")
    assert bot["display_name"] == "Research Scout"
    assert bot["title"] == "Some free-form title"
    assert profiles["meta"][0][1]["display_name"] == "Research Scout"


def test_explicit_display_name_wins(gw, profiles):
    from hexbot.bots import create_bot

    bot, _ = create_bot("scout", display_name="Scoutie", title="T")
    assert bot["display_name"] == "Scoutie"


def test_create_bot_refuses_a_duplicate(gw, profiles):
    from hexbot.bots import create_bot

    create_bot("scout")
    with pytest.raises(HexbotError) as caught:
        create_bot("scout")
    assert caught.value.code == 4208


def test_update_bot_routes_fields_to_the_right_place(gw, profiles):
    from hexbot.bots import create_bot, update_bot

    create_bot("scout", title="Old")
    gw.calls.clear()

    updated = update_bot("scout", title="New", persona="Terse", model="gpt-5.6")
    assert updated["title"] == "New"
    configure = gw.params_for("profiles.configure")[0]
    assert configure == {"name": "scout", "model": "gpt-5.6", "soul": "Terse"}


def test_bot_tools_and_skills_map_to_profile_config(gw, profiles):
    from hexbot.bots import create_bot, update_bot
    create_bot("scout")
    gw.responses["profiles.describe"] = {"skills": [
        {"name": "alpha", "enabled": True}, {"name": "beta", "enabled": True}]}
    gw.calls.clear()
    bot = update_bot("scout", tools=["files", "vision"], skills=["beta"],
                     dream_enabled=False)
    calls = gw.params_for("profiles.configure")
    # The toolset pin is its own call (it also writes platform_toolsets.cli);
    # skills ride on the general configure call.
    assert [c["enabled_toolsets"] for c in calls if "enabled_toolsets" in c] == [["file", "vision"]]
    assert [c["disabled_skills"] for c in calls if "disabled_skills" in c] == [["alpha"]]
    assert bot["tools"] == ["files", "vision"]
    assert bot["skills"] == ["beta"]
    assert bot["dream_enabled"] is False
    assert "may_write_core" not in bot


def test_update_bot_rejects_unknown_fields(gw, profiles):
    from hexbot.bots import create_bot, update_bot

    create_bot("scout")
    with pytest.raises(HexbotError) as caught:
        update_bot("scout", nonsense=1)
    assert caught.value.code == 4201


def test_update_bot_avatar_set_and_clear(gw, profiles):
    from hexbot.bots import create_bot, update_bot

    create_bot("scout")
    gw.calls.clear()
    update_bot("scout", avatar="ZGF0YQ==")
    assert gw.params_for("profiles.set_asset")[0]["data"] == "ZGF0YQ=="
    update_bot("scout", avatar=None)
    assert gw.params_for("profiles.set_asset")[1]["clear"] is True


def test_get_bot_reports_the_avatar(gw, profiles):
    from hexbot.bots import create_bot

    gw.responses["profiles.get_asset"] = {"found": True, "mime": "image/png", "data": "AAA"}
    bot, _ = create_bot("scout")
    assert bot["avatar"] == {"mime": "image/png", "data": "AAA"}


def test_missing_bot_is_4205(gw, profiles):
    from hexbot.bots import delete_bot, get_bot, update_bot

    for call in (get_bot, delete_bot):
        with pytest.raises(HexbotError) as caught:
            call("ghost")
        assert caught.value.code == 4205
    with pytest.raises(HexbotError) as caught:
        update_bot("ghost", title="x")
    assert caught.value.code == 4205


def test_delete_bot_closes_sessions_rows_and_profile(gw, profiles):
    from hexbot import db
    from hexbot.bots import create_bot, delete_bot

    create_bot("scout")
    with db.transaction() as conn:
        conn.execute("INSERT INTO dreams(id,bot,started_at,status,summary) "
                     "VALUES ('d1','scout',0,'complete','kept')")
    gw.calls.clear()
    assert delete_bot("scout") is True

    assert "session.close" in gw.methods()
    assert gw.params_for("session.delete")[0] == {"session_id": "stored1", "profile": "scout"}
    assert profiles["deleted"] == ["scout"]
    with db.transaction() as conn:
        assert conn.execute("select count(*) from bots").fetchone()[0] == 0
        assert conn.execute("select count(*) from sections").fetchone()[0] == 0
        assert conn.execute("select count(*) from dreams").fetchone()[0] == 0


def test_delete_bot_refuses_a_streaming_section(gw, profiles):
    from hexbot.bots import create_bot, delete_bot

    create_bot("scout")
    gw.responses["session.active_list"] = {"sessions": [
        {"id": "live1", "session_key": "stored1", "status": "working"}]}

    with pytest.raises(HexbotError) as caught:
        delete_bot("scout")
    assert caught.value.code == 4211
    assert caught.value.data["sections"] == [{"id": "stored1", "status": "working"}]
    assert profiles["deleted"] == []


def test_delete_bot_allows_an_idle_section(gw, profiles):
    from hexbot.bots import create_bot, delete_bot

    create_bot("scout")
    gw.responses["session.active_list"] = {"sessions": [
        {"id": "live1", "session_key": "stored1", "status": "idle"}]}
    assert delete_bot("scout") is True


def test_delete_bot_survives_a_lost_stored_session(gw, profiles):
    from hexbot import db
    from hexbot.bots import create_bot, delete_bot

    create_bot("scout")

    def gone(_params):
        raise GatewayError(4007, "unknown session")

    gw.responses["session.delete"] = gone
    assert delete_bot("scout") is True
    with db.transaction() as conn:
        assert conn.execute("select count(*) from sections").fetchone()[0] == 0
    assert profiles["deleted"] == ["scout"]


def test_list_bots_orders_by_activity(gw, profiles):
    from hexbot import db
    from hexbot.bots import create_bot, list_bots

    create_bot("alpha")
    create_bot("beta")
    with db.transaction() as conn:
        conn.execute("UPDATE bots SET last_activity_at=1 WHERE name='alpha'")
        conn.execute("UPDATE bots SET last_activity_at=2 WHERE name='beta'")
    assert [bot["name"] for bot in list_bots()] == ["beta", "alpha"]


def test_bot_tools_default_to_everything_and_keep_unmanaged_toolsets(gw, profiles):
    from hexbot.bots import TOOL_TOOLSETS, create_bot, get_bot, update_bot
    create_bot("scout")
    # Hermes resolves the pin (or "everything" when unpinned); the Tools tab shows that.
    gw.responses["profiles.describe"] = {"toolsets": [
        {"name": n, "enabled": True} for n in ("memory", *TOOL_TOOLSETS.values())]}
    assert get_bot("scout")["tools"] == list(TOOL_TOOLSETS)
    gw.responses["profiles.describe"] = {"toolsets": [
        {"name": "memory", "enabled": True}, {"name": "terminal", "enabled": True},
        {"name": "vision", "enabled": True}, {"name": "hermes-discord", "enabled": False}]}
    assert get_bot("scout")["tools"] == ["terminal", "vision"]
    gw.calls.clear()
    update_bot("scout", tools=["terminal"])
    # Turning off vision keeps memory pinned; the allowlist never drops it.
    assert gw.params_for("profiles.configure")[0]["enabled_toolsets"] == ["memory", "terminal"]


def test_tools_patch_keeps_connector_toolsets_pinned(gw, profiles):
    """web, image_gen and mcp-* belong to connectors; a Tools patch leaves them alone."""
    from hexbot.bots import create_bot, update_bot
    create_bot("scout")
    gw.responses["profiles.describe"] = {"toolsets": [
        {"name": "web", "enabled": True}, {"name": "image_gen", "enabled": True},
        {"name": "terminal", "enabled": True}, {"name": "file", "enabled": True}]}
    gw.calls.clear()
    update_bot("scout", tools=["files"])
    assert gw.params_for("profiles.configure")[0]["enabled_toolsets"] == ["file", "image_gen", "web"]
    with pytest.raises(HexbotError) as caught:
        update_bot("scout", tools=["web_search"])
    assert caught.value.code == 4202


def test_new_bot_fields_default_and_update(gw, profiles):
    from hexbot.bots import create_bot, update_bot
    from ruamel.yaml import YAML
    bot, _ = create_bot("scout")
    assert bot["notify"] is True
    assert bot["approval_mode"] == "inherit"
    assert bot["workdir"] is None
    assert bot["status"] == "idle" and bot["status_detail"] is None

    bot = update_bot("scout", notify=False, approval_mode="off", workdir="~/Hexbot/scout")
    assert bot["notify"] is False
    assert bot["approval_mode"] == "off"
    assert bot["workdir"] == "~/Hexbot/scout"
    config = YAML(typ="safe").load((profiles["root"] / "scout" / "config.yaml").read_text())
    assert config["approvals"]["mode"] == "off"
    assert config["terminal"]["cwd"].endswith("Hexbot/scout")

    # The deployment mirror keeps the per-bot override.
    from hexbot.settings import update_settings
    update_settings({"approval_mode": "smart"})
    config = YAML(typ="safe").load((profiles["root"] / "scout" / "config.yaml").read_text())
    assert config["approvals"]["mode"] == "off"
    bot = update_bot("scout", approval_mode="inherit", workdir=None)
    config = YAML(typ="safe").load((profiles["root"] / "scout" / "config.yaml").read_text())
    assert config["approvals"]["mode"] == "smart"
    assert bot["approval_mode"] == "inherit" and bot["workdir"] is None

    for bad in ({"approval_mode": "auto"}, {"notify": "yes"}, {"workdir": ""}):
        with pytest.raises(HexbotError) as caught:
            update_bot("scout", **bad)
        assert caught.value.code == 4202


def test_status_follows_live_sessions_and_incidents(gw, profiles):
    from hexbot import incidents
    from hexbot.bots import clear_status, create_bot, get_bot, list_bots
    bot, section = create_bot("scout")

    gw.responses["session.active_list"] = {"sessions": [
        {"session_key": section["id"], "status": "working"}]}
    bot = get_bot("scout")
    assert bot["status"] == "working"
    assert bot["status_detail"]["section_id"] == section["id"]

    gw.responses["session.active_list"] = {"sessions": [
        {"session_key": section["id"], "status": "waiting"}]}
    assert get_bot("scout")["status"] == "needs_you"

    incident = incidents.record("scout", "connector_error", "Notion said 401",
                                connector="notion", section_id=section["id"])
    bot = list_bots()[0]
    assert bot["status"] == "stopped"
    assert bot["status_detail"]["action"] == {"kind": "fix_connector", "connector": "notion"}
    assert bot["status_detail"]["text"] == "Notion said 401"
    assert ("hexbot.bots.incident", {
        "bot": "scout", "section_id": section["id"], "room_id": None, "session_id": None,
        "incident": {k: incident[k] for k in
                     ("id", "kind", "connector", "text", "created_at", "resolved_at")}}) in gw.events
    assert ("hexbot.bots.changed", {"name": "scout"}) in gw.events

    assert clear_status("scout")["status"] == "needs_you"
    assert incidents.open_incidents() == {}


def test_introduce_submits_the_kickoff_hidden_into_the_bots_section(gw, profiles):
    from hexbot.bots import create_bot
    from hexbot.kickoff import KICKOFF_MARKER, introduce

    _bot, section = create_bot("scout", display_name="Scout")
    gw.responses["session.resume"] = {"session_id": "live1", "messages": []}
    gw.calls.clear()

    result = introduce("scout", section["id"])
    assert result["submitted"] is True
    [submitted] = gw.params_for("prompt.submit")
    assert submitted["session_id"] == "live1"
    assert submitted["display_kind"] == "hidden"
    assert submitted["text"].startswith(f'{KICKOFF_MARKER} "Scout"')

    create_bot("other")
    with pytest.raises(HexbotError) as caught:
        introduce("other", section["id"])
    assert caught.value.code == 4204

    # A section that already has messages is not a first run.
    gw.responses["session.resume"] = {"session_id": "live1",
                                      "messages": [{"role": "user", "content": "hi"}]}
    with pytest.raises(HexbotError) as caught:
        introduce("scout", section["id"])
    assert caught.value.code == 4243
