import re

import pytest

UPSTREAM = re.compile(r"hermes|nous", re.IGNORECASE)


@pytest.fixture
def providers():
    from hermes_cli.dashboard_auth import clear_providers, register_provider
    from hermes_cli.dashboard_auth.login_page import set_login_renderer
    from hexbot.auth_provider import HexbotAuthProvider, HexConnectProvider
    from hexbot.plugin import register

    class Context:  # the parts of Hermes's PluginContext that register() touches first
        def register_dashboard_auth_provider(self, provider): register_provider(provider)

    clear_providers()
    register(Context())  # installs Hexbot's sign-in page, as the daemon does at startup
    register_provider(HexConnectProvider())
    yield
    clear_providers()
    set_login_renderer(None)


def test_the_daemon_sign_in_page_is_hexbot_with_no_upstream_branding(providers):
    from fastapi.testclient import TestClient
    from hermes_cli import web_server

    page = TestClient(web_server.app, base_url="http://127.0.0.1:9119").get("/login?next=/r/kitchen").text
    assert not UPSTREAM.findall(page), UPSTREAM.findall(page)
    assert "<title>Sign in · Hexbot</title>" in page
    assert 'href="/auth/login?provider=connect&next=%2Fr%2Fkitchen">Sign in with Hex Connect</a>' in page
    assert 'data-provider="hexbot"' in page and 'name="password"' in page and 'value="/r/kitchen"' in page


def test_the_unavailable_page_has_no_upstream_branding():
    from hermes_cli.dashboard_auth import clear_providers
    from hexbot.login_page import render_login_html

    clear_providers()
    page = render_login_html()
    assert "Sign-in unavailable" in page and not UPSTREAM.findall(page)


def test_next_is_escaped(providers):
    from hexbot.login_page import render_login_html

    page = render_login_html(next_path='/"><script>x</script>')
    assert "<script>x</script>" not in page
