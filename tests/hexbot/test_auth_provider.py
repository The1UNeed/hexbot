from types import SimpleNamespace
import base64
import hashlib
import json
import secrets
import shutil
import time
import urllib.parse

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec


needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="the Connect sidecar runs on Node")


def _grant(*, daemon_id="daemon-1", kid="key-1", expires=300, malformed=False, jti=True, issued_in=0,
           sub="user-1", iss="https://example.test"):
    """A grant plus a daemon registered to trust its key, owner, and issuer. The published-key
    cache is fresh, so the sidecar verifies without the network."""
    from hexbot.connect import ConnectConfig
    from hexbot.home import hexbot_home

    key = ec.generate_private_key(ec.SECP256R1())
    jwk = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(key.public_key()))
    jwk.update({"kid": "key-1", "use": "sig", "alg": "ES256"})
    now = int(time.time()) + issued_in
    claims = {"iss": iss, "aud": daemon_id, "sub": sub, "daemon_id": daemon_id, "device_name": "MacBook",
              "iat": now, "exp": now + expires, "jti": secrets.token_hex(8)}
    if malformed:
        claims.pop("device_name")
    if not jti:
        claims.pop("jti")
    ConnectConfig(api_base="https://example.test", daemon_id="daemon-1", daemon_token="secret",
                  owner_id="user-1", issuer="https://example.test", keys=[jwk]).save()
    (hexbot_home() / "connect-jwks.json").write_text(json.dumps({"at": time.time(), "keys": [jwk]}))
    return jwt.encode(claims, key, algorithm="ES256", headers={"kid": kid, "typ": "hexbot-grant+jwt"})


@needs_node
def test_connect_grant_mints_connect_device():
    from hexbot.auth_provider import HexbotAuthProvider

    token = _grant()
    provider = HexbotAuthProvider()
    session = provider.complete_password_login(username="ignored", password="cg_" + token)
    assert session.display_name == "MacBook" and session.access_token.startswith("hxb_")
    assert provider.verify_session(access_token=session.access_token).display_name == "MacBook"
    from hexbot.pairing import list_devices
    assert list_devices()[0].platform == "connect"


@needs_node
def test_connect_grant_is_single_use_across_restarts():
    from hermes_cli.dashboard_auth import InvalidCredentialsError
    from hexbot import db
    from hexbot.auth_provider import HexbotAuthProvider

    token = _grant()
    provider = HexbotAuthProvider()
    provider.complete_password_login(username="ignored", password="cg_" + token)
    with db.transaction() as conn:
        assert conn.execute("SELECT count(*) FROM spent_grants").fetchone()[0] == 1
    # A new provider instance stands in for a restarted daemon: the spent grant is on disk.
    restarted = HexbotAuthProvider()
    with pytest.raises(InvalidCredentialsError):
        restarted.complete_password_login(username="ignored", password="cg_" + token)


@needs_node
def test_connect_grant_tolerates_a_slow_daemon_clock():
    from hexbot.auth_provider import HexbotAuthProvider

    token = _grant(issued_in=30)  # Connect's clock is half a minute ahead
    provider = HexbotAuthProvider()
    assert provider.complete_password_login(username="ignored", password="cg_" + token).display_name == "MacBook"


@needs_node
@pytest.mark.parametrize("kind", ["expired", "wrong_daemon", "wrong_kid", "malformed", "no_jti",
                                  "wrong_owner", "wrong_issuer"])
def test_invalid_connect_grants(kind):
    from hermes_cli.dashboard_auth import InvalidCredentialsError
    from hexbot.auth_provider import HexbotAuthProvider

    kwargs = {
        "expired": {"expires": -120},  # past the sixty seconds of leeway
        "wrong_daemon": {"daemon_id": "other"},
        "wrong_kid": {"kid": "missing"},
        "malformed": {"malformed": True},
        "no_jti": {"jti": False},
        "wrong_owner": {"sub": "someone-else"},  # a Connect account that is not this daemon's owner
        "wrong_issuer": {"iss": "https://evil.test"},
    }[kind]
    token = _grant(**kwargs)
    with pytest.raises(InvalidCredentialsError):
        HexbotAuthProvider().complete_password_login(username="ignored", password="cg_" + token)


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


def _connect_config():
    from hexbot.connect import ConnectConfig
    ConnectConfig(api_base="https://example.test", daemon_id="daemon-1", daemon_token="secret",
                  owner_id="user-1", issuer="https://example.test", keys=[{"kid": "key-1"}]).save()


def test_connect_provider_start_login():
    from hermes_cli.dashboard_auth import ProviderError
    from hexbot.auth_provider import HexConnectProvider

    provider = HexConnectProvider()
    with pytest.raises(ProviderError):
        provider.start_login(redirect_uri="https://daemon.test/auth/callback")
    _connect_config()
    start = provider.start_login(redirect_uri="https://daemon.test/auth/callback")
    assert start.redirect_url.startswith("https://example.test/connect/browser?")
    query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(start.redirect_url).query))
    assert query["daemon"] == "daemon-1"
    assert query["redirect_uri"] == "https://daemon.test/auth/callback"
    pkce = dict(seg.split("=", 1) for seg in start.cookie_payload["hermes_session_pkce"].split(";"))
    assert pkce["state"] == query["state"]
    digest = hashlib.sha256(pkce["verifier"].encode("ascii")).digest()
    assert query["code_challenge"] == base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def _exchange(reply):
    calls = []

    def http(method, url, **kwargs):
        calls.append((method, url, kwargs))
        if isinstance(reply, Exception):
            raise reply
        return reply
    return calls, http


@needs_node
def test_connect_provider_complete_login_mints_device():
    from hexbot.auth_provider import HexConnectProvider
    from hexbot.pairing import list_devices

    token = _grant()
    calls, http = _exchange({"grant": token, "device_name": "Chrome on macOS"})
    provider = HexConnectProvider(http=http)
    session = provider.complete_login(code="code-1", state="state-1", code_verifier="ver",
                                      redirect_uri="https://daemon.test/auth/callback")
    method, url, kwargs = calls[0]
    assert (method, url) == ("POST", "https://example.test/api/grants/exchange")
    assert kwargs["headers"] == {"Authorization": "Bearer secret"}
    assert kwargs["json"] == {"code": "code-1", "code_verifier": "ver",
                              "redirect_uri": "https://daemon.test/auth/callback"}
    assert (session.provider, session.display_name) == ("connect", "MacBook")
    assert provider.verify_session(access_token=session.access_token).user_id == session.user_id
    assert list_devices()[0].platform == "connect"


@needs_node
@pytest.mark.parametrize(("reply", "expected"), [
    ("rejected", "InvalidCodeError"), ("unreachable", "ProviderError"),
    ("wrong_daemon", "InvalidCodeError"),
])
def test_connect_provider_complete_login_failures(reply, expected):
    import hermes_cli.dashboard_auth as auth
    from hexbot.auth_provider import HexConnectProvider
    from hexbot.errors import HexbotError

    token = _grant(daemon_id="other")
    calls, http = _exchange({
        "rejected": HexbotError(4243, "Connect sign-in code rejected"),
        "unreachable": HexbotError(5241, "Connect service unreachable"),
        "wrong_daemon": {"grant": token, "device_name": "Chrome"},
    }[reply])
    provider = HexConnectProvider(http=http)
    with pytest.raises(getattr(auth, expected)):
        provider.complete_login(code="c", state="s", code_verifier="v",
                                redirect_uri="https://daemon.test/auth/callback")


def test_provider_shape_and_protocol():
    from hermes_cli.dashboard_auth import assert_protocol_compliance, RefreshExpiredError
    from hexbot.auth_provider import HexbotAuthProvider, HexConnectProvider

    assert_protocol_compliance(HexbotAuthProvider)
    assert_protocol_compliance(HexConnectProvider)
    provider = HexbotAuthProvider()
    assert (provider.name, provider.supports_password, provider.supports_session,
            provider.supports_token) == ("hexbot", True, True, False)
    browser = HexConnectProvider()
    assert (browser.name, browser.supports_password, browser.supports_session,
            browser.supports_token) == ("connect", False, True, False)
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
