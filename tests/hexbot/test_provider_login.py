"""Provider sign-in state machine, with the network flows stubbed."""

import threading

import pytest

from hexbot import provider_login
from hexbot.errors import HexbotError
from hexbot.settings import DEFAULTS, mirror_deployment_config, update_settings


def test_unsupported_providers_point_at_the_cli(monkeypatch):
    monkeypatch.setattr(provider_login, "FLOWS", {})
    result = provider_login.start("openai-codex")
    assert result["supported"] is False
    assert "hexbot core auth login openai-codex" in result["message"]


def test_login_reports_code_then_completion(monkeypatch):
    release = threading.Event()

    def flow(login):
        login.url, login.code, login.status = "https://example.test/device", "ABCD-1234", "pending"
        login.ready.set()
        release.wait(5)

    monkeypatch.setattr(provider_login, "FLOWS", {"openai-codex": flow})
    started = provider_login.start("openai-codex")
    assert started["supported"] is True
    assert started["status"] == "pending"
    assert started["url"] == "https://example.test/device"
    assert started["code"] == "ABCD-1234"
    release.set()
    for _ in range(50):
        polled = provider_login.poll(started["login_id"])
        if polled["status"] == "done":
            break
        threading.Event().wait(0.02)
    assert polled["status"] == "done"


def test_login_errors_are_surfaced(monkeypatch):
    def flow(login):
        raise HexbotError(4211, "nope")

    monkeypatch.setattr(provider_login, "FLOWS", {"openai-codex": flow})
    started = provider_login.start("openai-codex")
    assert started["status"] == "error"
    assert started["message"] == "nope"


def test_cancel_stops_a_pending_login(monkeypatch):
    def flow(login):
        login.status = "pending"
        login.ready.set()
        login.cancel.wait(5)

    monkeypatch.setattr(provider_login, "FLOWS", {"openai-codex": flow})
    started = provider_login.start("openai-codex")
    cancelled = provider_login.cancel(started["login_id"])
    assert cancelled["status"] == "cancelled"
    with pytest.raises(HexbotError):
        provider_login.poll("missing")


def test_default_and_fallback_models_are_validated_and_mirrored(isolated_home):
    assert DEFAULTS["default_model"] is None and DEFAULTS["fallback_model"] is None
    with pytest.raises(HexbotError):
        update_settings({"default_model": "gpt-5"})
    update_settings({"default_model": "openai/gpt-5", "fallback_model": "anthropic/claude"})
    mirror_deployment_config(isolated_home)
    text = (isolated_home / "config.yaml").read_text()
    assert "fallback_providers" in text and "anthropic" in text
    update_settings({"fallback_model": None})
    mirror_deployment_config(isolated_home)
    assert "fallback_providers" not in (isolated_home / "config.yaml").read_text()


def test_clear_key_signs_out_of_subscription_providers(monkeypatch):
    from hexbot import providers
    from hermes_cli import auth

    store = {"providers": {"openai-codex": {"tokens": {"access_token": "x"}}},
             "active_provider": "openai-codex"}
    saved = {}
    monkeypatch.setattr(providers, "_auth_type", lambda slug: "oauth_external")
    monkeypatch.setattr(providers, "_env_vars", lambda slug: ())
    monkeypatch.setattr(auth, "_load_auth_store", lambda: store)
    monkeypatch.setattr(auth, "_save_auth_store", lambda value: saved.update(value))
    assert providers.clear_key("openai-codex") == {"provider": "openai-codex", "configured": False}
    assert "openai-codex" not in saved["providers"]
    assert "active_provider" not in saved
