import pytest


def test_bot_lifecycle_uses_profile_gateway(tmp_path, monkeypatch):
    calls = []
    def fake(method, params, rid=None):
        calls.append((method, params))
        if method == "profiles.create": return {}
        if method == "session.create": return {"session_id": "live", "stored_session_id": "stored", "messages": []}
        if method == "profiles.describe": return {"description": "Research", "soul": "Careful", "model": {"provider": "openai", "default": "gpt"}}
        if method == "profiles.get_asset": return {"found": False}
        if method == "session.list": return {"sessions": []}
        return {}
    monkeypatch.setattr("hexbot.gateway.call", fake)
    monkeypatch.setattr("hermes_cli.profiles.validate_profile_name", lambda name: None)
    monkeypatch.setattr("hermes_cli.profiles.get_profile_dir", lambda name: tmp_path / "profiles" / name)
    monkeypatch.setattr("hermes_cli.profiles.write_profile_meta", lambda *a, **k: None)
    from hexbot.bots import create_bot, get_bot, update_bot
    bot, section = create_bot("scout", title="Research scout", description="Research",
                              persona="Careful", provider="openai", model="gpt")
    assert bot["name"] == "scout" and section["title"] == "General"
    assert next(params for method, params in calls if method == "profiles.create")["mirror_credentials"] is True
    assert update_bot("scout", title="Scout")["title"] == "Scout"


def test_section_lifecycle_and_dead_live_session(monkeypatch):
    calls = []
    dead = {"value": False}
    def fake(method, params, rid=None):
        calls.append((method, params))
        if method == "session.create": return {"session_id": "live1", "stored_session_id": "stored1", "messages": []}
        if method == "session.resume":
            if dead["value"]: return {"session_id": "live2", "messages": []}
            return {"session_id": "live1", "messages": [{"role": "user", "content": "hi"}]}
        if method == "session.list": return {"sessions": []}
        return {}
    monkeypatch.setattr("hexbot.gateway.call", fake)
    from hexbot import sections
    made = sections.create_section("scout", "General")
    assert made["id"] == "stored1"
    assert len(sections.open_section("stored1")["messages"]) == 1
    dead["value"] = True
    assert sections.open_section("stored1")["section"]["live_session_id"] == "live2"
    sections.rename_section("stored1", "Renamed")
    assert sections.archive_section("stored1")["archived_at"] is not None
    assert sections.unarchive_section("stored1")["archived_at"] is None
    assert sections.delete_section("stored1") is True


def test_rpc_frames_and_real_dispatch(monkeypatch):
    from hermes_cli.plugins import _PLUGIN_RPC_METHODS
    from tui_gateway import server
    _PLUGIN_RPC_METHODS.clear()
    class Ctx:
        def register_rpc_method(self, name, fn): _PLUGIN_RPC_METHODS[name] = fn
        def register_system_prompt_section(self, *a, **k): pass
    from hexbot.plugin import register
    register(Ctx())
    ok = server.handle_request({"jsonrpc": "2.0", "id": 1, "method": "hexbot.info", "params": {}})
    from hexbot import __version__
    assert ok["result"]["version"] == __version__
    bad = server.handle_request({"jsonrpc": "2.0", "id": 2, "method": "hexbot.memory.core.set", "params": {"section": "rules", "text": "x" * 4001}})
    assert bad["error"]["code"] == 4221
