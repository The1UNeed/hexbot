"""RPC frames, event emission and dispatch through the real gateway server."""

import pytest


class RecordingCtx:
    """A minimal PluginContext: records registrations, refuses duplicates."""

    def __init__(self):
        self.methods = {}
        self.prompt_sections = []
        self.hooks = []
        self.tools = []

    def register_rpc_method(self, name, fn):
        assert name.startswith("hexbot."), name
        assert name not in self.methods, f"duplicate {name}"
        self.methods[name] = fn

    def register_system_prompt_section(self, id, content, *, position="after_memory",
                                       max_chars=4000):
        self.prompt_sections.append((id, content, position, max_chars))

    def register_hook(self, name, callback):
        self.hooks.append((name, callback))

    def register_tool(self, **kwargs):
        self.tools.append(kwargs)


@pytest.fixture
def ctx(fake_gateway):
    from hexbot.plugin import register

    context = RecordingCtx()
    register(context)
    return context


def call(ctx, method, params=None, rid=1):
    return ctx.methods[method](rid, params or {})


def test_every_documented_method_is_registered(ctx):
    expected = {
        "hexbot.info", "hexbot.settings.get", "hexbot.settings.set",
        "hexbot.bots.list", "hexbot.bots.get", "hexbot.bots.create",
        "hexbot.bots.update", "hexbot.bots.delete",
        "hexbot.sections.list", "hexbot.sections.create", "hexbot.sections.open",
        "hexbot.sections.rename", "hexbot.sections.archive",
        "hexbot.sections.unarchive", "hexbot.sections.delete", "hexbot.sections.touch",
        "hexbot.memory.core.get", "hexbot.memory.core.set",
        "hexbot.memory.bot.get", "hexbot.memory.bot.set",
        "hexbot.providers.list", "hexbot.providers.set_key",
        "hexbot.providers.clear_key", "hexbot.models.list",
        "hexbot.network.get", "hexbot.network.set",
        "hexbot.pairing.code", "hexbot.devices.list", "hexbot.devices.revoke",
        "hexbot.connect.status", "hexbot.connect.disconnect",
        "hexbot.connect.register_start", "hexbot.connect.register_poll",
        "hexbot.rooms.list", "hexbot.rooms.get", "hexbot.rooms.create",
        "hexbot.rooms.update", "hexbot.rooms.add_member",
        "hexbot.rooms.remove_member", "hexbot.rooms.send", "hexbot.rooms.log",
        "hexbot.rooms.stop", "hexbot.rooms.archive", "hexbot.rooms.delete",
            "hexbot.rooms.mark_read", "hexbot.activity.pairs", "hexbot.activity.list",
            "hexbot.dreaming.status", "hexbot.dreaming.run_now", "hexbot.dreaming.list",
            "hexbot.users.me", "hexbot.users.list", "hexbot.users.invite",
            "hexbot.users.update", "hexbot.usage.summary",
    }
    assert set(ctx.methods) == expected


def test_core_memory_is_registered_as_four_prompt_sections(ctx):
    from hermes_cli.plugins import (MAX_SYSTEM_PROMPT_SECTION_CHARS,
                                    SYSTEM_PROMPT_SECTION_POSITIONS)

    assert len(ctx.prompt_sections) == 4
    ids = [entry[0] for entry in ctx.prompt_sections]
    assert ids == ["hexbot.core-memory.user", "hexbot.core-memory.household",
                   "hexbot.core-memory.workspace", "hexbot.core-memory.rules"]
    for _id, content, position, max_chars in ctx.prompt_sections:
        assert callable(content)
        assert position in SYSTEM_PROMPT_SECTION_POSITIONS
        assert max_chars == MAX_SYSTEM_PROMPT_SECTION_CHARS

    from hexbot.memory import set_core_memory
    set_core_memory("workspace", "Repo: /srv/hexbot")
    renderer = dict((entry[0], entry[1]) for entry in ctx.prompt_sections)
    assert "Repo: /srv/hexbot" in renderer["hexbot.core-memory.workspace"]({})
    assert renderer["hexbot.core-memory.rules"]({}) == ""


def test_dream_digest_tool_is_registered(ctx):
    assert [tool["name"] for tool in ctx.tools] == ["message_bot", "hexbot_dream_digest"]
    dream = ctx.tools[1]
    assert dream["toolset"] == "hexbot"
    assert dream["schema"]["function"]["parameters"]["required"] == ["bot"]


def test_info_frame(ctx):
    frame = call(ctx, "hexbot.info")
    assert frame["jsonrpc"] == "2.0"
    assert frame["id"] == 1
    result = frame["result"]
    assert result["version"] == "0.1.0"
    assert result["home"]
    assert result["lan_enabled"] is False
    assert isinstance(result["addresses"], list)
    assert set(result) == {"version", "hermes_version", "daemon_name", "install_id",
                           "auth_required", "pairing_supported", "lan_enabled", "addresses",
                           "platform", "home"}


def test_missing_parameter_is_4200(ctx):
    frame = call(ctx, "hexbot.bots.get", {})
    assert frame["error"]["code"] == 4200
    assert "name" in frame["error"]["message"]


def test_unknown_parameter_is_4201(ctx):
    frame = call(ctx, "hexbot.bots.update", {"name": "x", "nonsense": 1})
    assert frame["error"]["code"] == 4201


def test_core_memory_cap_surfaces_as_4221(ctx):
    frame = call(ctx, "hexbot.memory.core.set", {"section": "rules", "text": "x" * 4001})
    assert frame["error"]["code"] == 4221
    assert "4000" in frame["error"]["message"]


def test_unknown_core_memory_section_is_4203(ctx):
    frame = call(ctx, "hexbot.memory.core.set", {"section": "nope", "text": ""})
    assert frame["error"]["code"] == 4203


def test_unknown_section_is_4204(ctx):
    frame = call(ctx, "hexbot.sections.open", {"id": "ghost"})
    assert frame["error"]["code"] == 4204


def test_unknown_bot_is_4205(ctx):
    assert call(ctx, "hexbot.bots.get", {"name": "ghost"})["error"]["code"] == 4205


def test_settings_validation_frames(ctx):
    assert call(ctx, "hexbot.settings.set", {"patch": {"bad": 1}})["error"]["code"] == 4201
    assert call(ctx, "hexbot.settings.set",
                {"patch": {"approval_mode": "loud"}})["error"]["code"] == 4202
    ok = call(ctx, "hexbot.settings.set", {"patch": {"approval_mode": "smart"}})
    assert ok["result"]["approval_mode"] == "smart"


def test_dreaming_rpc_frames(ctx, monkeypatch):
    monkeypatch.setattr("hexbot.dreaming.status", lambda bot: {
        "enabled": True, "last_run_at": 1, "next_run_at": 2,
        "last_status": "success", "last_error": None})
    monkeypatch.setattr("hexbot.dreaming.run_now", lambda bot: {"job": {"id": "j1"}})
    monkeypatch.setattr("hexbot.dreaming.list_dreams",
                        lambda bot, limit=20: {"dreams": [{"id": "d1"}]})
    assert call(ctx, "hexbot.dreaming.status", {"bot": "scout"})["result"]["enabled"]
    assert call(ctx, "hexbot.dreaming.run_now", {"bot": "scout"})["result"]["job"]["id"] == "j1"
    assert call(ctx, "hexbot.dreaming.list", {"bot": "scout", "limit": 1})["result"]["dreams"][0]["id"] == "d1"


def test_unexpected_failures_become_5200(ctx, monkeypatch):
    def boom():
        raise RuntimeError("disk on fire")

    monkeypatch.setattr("hexbot.settings.get_settings", boom)
    frame = call(ctx, "hexbot.settings.get")
    assert frame["error"]["code"] == 5200
    assert frame["error"]["message"] == "disk on fire"


def test_gateway_errors_pass_their_code_through(ctx, fake_gateway):
    from hexbot.errors import GatewayError

    def boom(_params):
        raise GatewayError(4062, "profile exists")

    fake_gateway.responses["session.create"] = boom
    frame = call(ctx, "hexbot.sections.create", {"bot": "scout"})
    assert frame["error"]["code"] == 4062


def test_mutations_broadcast_events(ctx, fake_gateway):
    fake_gateway.responses.update({
        "session.create": {"session_id": "live1", "stored_session_id": "stored1",
                           "messages": []},
        "session.list": {"sessions": []},
    })
    call(ctx, "hexbot.sections.create", {"bot": "scout"})
    call(ctx, "hexbot.sections.rename", {"id": "stored1", "title": "Renamed"})
    call(ctx, "hexbot.memory.core.set", {"section": "user", "text": "Name: Alex"})

    assert [name for name, _ in fake_gateway.events] == [
        "hexbot.sections.changed", "hexbot.sections.changed", "hexbot.memory.core.changed"]
    assert fake_gateway.events[0][1]["id"] == "stored1"
    assert fake_gateway.events[0][1]["bot"] == "scout"
    assert fake_gateway.events[1][1]["id"] == "stored1"
    assert fake_gateway.events[2][1] == {}


def test_a_failed_mutation_emits_nothing(ctx, fake_gateway):
    call(ctx, "hexbot.memory.core.set", {"section": "rules", "text": "x" * 4001})
    assert fake_gateway.events == []


def test_models_list_forwards_optional_params(ctx, fake_gateway):
    fake_gateway.responses["model.options"] = {"providers": []}
    frame = call(ctx, "hexbot.models.list",
                 {"provider": "anthropic", "include_unconfigured": True, "refresh": True})
    assert set(frame["result"]) >= {"curated", "all"}
    assert fake_gateway.params_for("model.options")[0] == {
        "include_unconfigured": True, "refresh": True}


def test_activity_hook_resolves_the_stored_session_id(ctx, fake_gateway):
    """``on_stream_end`` hands over the agent's session id (the STORED id)."""
    from hexbot import db, sections

    fake_gateway.responses.update({
        "session.create": {"session_id": "live1", "stored_session_id": "stored1",
                           "messages": []},
        "session.list": {"sessions": []},
    })
    sections.create_section("scout", "General")
    with db.transaction() as conn:
        conn.execute("UPDATE sections SET updated_at=0 WHERE id='stored1'")

    assert [name for name, _ in ctx.hooks] == [
        "on_stream_end", "post_tool_call", "post_llm_call", "on_session_end"]
    hook = ctx.hooks[0][1]

    hook(session_id="stored1", finished=False)
    with db.transaction() as conn:
        assert conn.execute(
            "select updated_at from sections where id='stored1'").fetchone()[0] == 0

    hook(session_id="stored1", finished=True, final_text="hi", error=None)
    with db.transaction() as conn:
        assert conn.execute(
            "select updated_at from sections where id='stored1'").fetchone()[0] > 0

    # Unknown ids and hook failures must never escape into the agent loop.
    hook(session_id="who", finished=True)
    hook(finished=True)


def test_plugin_skips_registration_on_an_old_context():
    from hexbot.plugin import register

    class Ancient:
        def register_system_prompt_section(self, *args, **kwargs):
            raise AssertionError("must not be called")

    register(Ancient())  # no exception


def test_register_against_the_real_gateway_and_dispatch(monkeypatch):
    """End to end: real PluginContext plumbing + real ``handle_request``."""
    from hermes_cli.plugins import _PLUGIN_RPC_METHODS
    from tui_gateway import server

    saved = dict(_PLUGIN_RPC_METHODS)
    _PLUGIN_RPC_METHODS.clear()
    try:
        from hexbot.plugin import register
        register(_RealishCtx())

        ok = server.handle_request(
            {"jsonrpc": "2.0", "id": 1, "method": "hexbot.info", "params": {}})
        assert ok["result"]["version"] == "0.1.0"
        assert ok["result"]["home"]

        bad = server.handle_request({"jsonrpc": "2.0", "id": 2,
                                     "method": "hexbot.memory.core.set",
                                     "params": {"section": "rules", "text": "x" * 4001}})
        assert bad["error"]["code"] == 4221

        missing = server.handle_request({"jsonrpc": "2.0", "id": 3,
                                         "method": "hexbot.nope", "params": {}})
        assert missing["error"]["code"] == -32601
    finally:
        _PLUGIN_RPC_METHODS.clear()
        _PLUGIN_RPC_METHODS.update(saved)


class _RealishCtx(RecordingCtx):
    """Registers into the real ``_PLUGIN_RPC_METHODS`` table."""

    def register_rpc_method(self, name, fn):
        from hermes_cli.plugins import _PLUGIN_RPC_METHODS
        super().register_rpc_method(name, fn)
        _PLUGIN_RPC_METHODS[name] = fn


def test_bundled_plugin_manifest_matches_the_entry_point():
    import yaml

    import plugins.hexbot as bundled
    from hexbot.plugin import register

    manifest = yaml.safe_load(
        (__import__("pathlib").Path(bundled.__file__).parent / "plugin.yaml").read_text())
    assert manifest["name"] == "hexbot"
    assert manifest["kind"] == "backend"
    assert bundled.register is register
