from types import SimpleNamespace

import pytest


def test_provider_login_session_and_bad_credentials():
    from hermes_cli.dashboard_auth import InvalidCredentialsError, Session
    from hexbot.auth_provider import HexbotAuthProvider
    from hexbot.pairing import new_code

    provider = HexbotAuthProvider()
    session = provider.complete_password_login(username="  browser  ", password=new_code())
    assert isinstance(session, Session)
    assert session.user_id.startswith("device:")
    assert session.display_name == "browser"
    assert session.provider == "hexbot"
    assert session.access_token.startswith("hxb_") and session.refresh_token == ""
    assert provider.verify_session(access_token=session.access_token).user_id == session.user_id
    with pytest.raises(InvalidCredentialsError):
        provider.complete_password_login(username="bad", password="wrong")


def test_password_login_http_success_and_401():
    from fastapi.testclient import TestClient
    from hermes_cli import web_server
    from hermes_cli.dashboard_auth import clear_providers, register_provider
    from hermes_cli.dashboard_auth.routes import _reset_password_rate_limit
    from hexbot.auth_provider import HexbotAuthProvider
    from hexbot.pairing import new_code

    clear_providers()
    _reset_password_rate_limit()
    register_provider(HexbotAuthProvider())
    try:
        client = TestClient(web_server.app, base_url="http://127.0.0.1:9119")
        bad = client.post("/auth/password-login", json={
            "provider": "hexbot", "username": "browser", "password": "wrong"})
        assert bad.status_code == 401
        good = client.post("/auth/password-login", json={
            "provider": "hexbot", "username": "browser", "password": new_code()})
        assert good.status_code == 200
        assert good.cookies["hermes_session_at"].startswith("hxb_")
        assert good.cookies["hermes_session_provider"] == "hexbot"
    finally:
        clear_providers()
        _reset_password_rate_limit()


def test_provider_shape_and_protocol():
    from hermes_cli.dashboard_auth import assert_protocol_compliance, RefreshExpiredError
    from hexbot.auth_provider import HexbotAuthProvider

    assert_protocol_compliance(HexbotAuthProvider)
    provider = HexbotAuthProvider()
    assert (provider.name, provider.supports_password, provider.supports_session,
            provider.supports_token) == ("hexbot", True, True, False)
    with pytest.raises(RefreshExpiredError):
        provider.refresh_session(refresh_token="")


def test_plugin_registers_auth_provider():
    from hexbot.plugin import register

    class Context:
        def __init__(self): self.provider = None
        def register_dashboard_auth_provider(self, provider): self.provider = provider
        def register_rpc_method(self, *_args): pass
        def register_system_prompt_section(self, *_args, **_kwargs): pass
        def register_hook(self, *_args): pass

    ctx = Context()
    register(ctx)
    assert ctx.provider.name == "hexbot"


def test_pairing_and_device_rpc_handlers(monkeypatch):
    from hexbot import pairing
    from hexbot.rpc import METHODS

    monkeypatch.setattr("hexbot.network.lan_addresses", lambda: ["192.168.1.4"])
    code_result = METHODS["hexbot.pairing.code"]({})
    assert code_result["addresses"] == ["192.168.1.4"]
    assert code_result["link"].endswith(f"#code={code_result['code']}")
    device = pairing.redeem_code(
        code_result["code"], device_name="rpc", platform="browser")
    transport = SimpleNamespace(auth_identity={"user_id": f"device:{device.id}",
                                                  "provider": "hexbot"})
    monkeypatch.setattr("tui_gateway.server.current_transport", lambda: transport)
    listed = METHODS["hexbot.devices.list"]({})["devices"]
    assert listed[0]["current"] is True
    assert METHODS["hexbot.devices.revoke"]({"id": device.id}) == {"revoked": True}
