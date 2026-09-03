"""Provider credentials, the model picker projection and LAN addresses."""

import pytest


@pytest.fixture
def fake_provider(monkeypatch):
    from providers.base import ProviderProfile

    profile = ProviderProfile(name="fake", display_name="Fake Provider",
                              env_vars=("FAKE_API_KEY",))
    monkeypatch.setattr("providers.get_provider_profile",
                        lambda name: profile if name in {"fake", "faux"} else None)
    monkeypatch.delenv("FAKE_API_KEY", raising=False)
    return profile


def test_provider_key_is_written_and_mirrored(isolated_home, fake_provider, monkeypatch):
    from hexbot.providers import clear_key, set_key

    for name in ("one", "two"):
        (isolated_home / "profiles" / name).mkdir(parents=True)

    set_key("fake", "secret")
    targets = (isolated_home, isolated_home / "profiles/one", isolated_home / "profiles/two")
    for path in targets:
        assert "FAKE_API_KEY='secret'" in (path / ".env").read_text()
        assert (path / ".env").stat().st_mode & 0o777 == 0o600

    clear_key("fake")
    for path in targets:
        assert "FAKE_API_KEY" not in (path / ".env").read_text()


def test_set_key_keeps_other_env_lines(isolated_home, fake_provider):
    from hexbot.providers import set_key

    (isolated_home / ".env").write_text("OTHER_KEY='keep'\n")
    set_key("fake", "secret")
    text = (isolated_home / ".env").read_text()
    assert "OTHER_KEY='keep'" in text
    assert "FAKE_API_KEY='secret'" in text


def test_set_key_rejects_unknown_providers(monkeypatch):
    from hexbot.errors import HexbotError
    from hexbot.providers import set_key

    monkeypatch.setattr("providers.get_provider_profile", lambda name: None)
    monkeypatch.setattr("hermes_cli.auth.PROVIDER_REGISTRY", {})
    with pytest.raises(HexbotError) as caught:
        set_key("nope", "secret")
    assert caught.value.code == 4206


def test_provider_aliases_resolve_to_hermes_slugs():
    from hexbot.providers import canonical_provider

    assert canonical_provider("openai") == "openai-api"
    assert canonical_provider("chatgpt") == "openai-codex"
    assert canonical_provider("claude") == "anthropic"
    assert canonical_provider("grok") == "xai"
    assert canonical_provider("anthropic") == "anthropic"
    assert canonical_provider(None) == ""


def test_list_providers_reports_labels_and_oauth_state(monkeypatch):
    from hexbot import providers

    monkeypatch.setattr(providers, "_known_slugs", lambda: ["anthropic", "openai-codex"])
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    seen = {}

    def fake_oauth(slug):
        seen[slug] = True
        return slug == "openai-codex"

    monkeypatch.setattr(providers, "_oauth_credentials_present", fake_oauth)
    rows = {row["id"]: row for row in providers.list_providers()}

    assert rows["anthropic"]["configured"] is True
    assert rows["anthropic"]["label"] == "Anthropic"
    # OAuth providers report a real boolean, never null.
    assert rows["openai-codex"]["configured"] is True
    assert rows["openai-codex"]["auth_type"] == "oauth_external"
    assert rows["openai-codex"]["label"] and rows["openai-codex"]["label"] != "openai-codex"
    assert seen == {"openai-codex": True}


def test_codex_oauth_detection_uses_the_auth_store(monkeypatch):
    from hexbot import providers

    calls = []

    class Boom(Exception):
        pass

    def reader():
        calls.append("read")
        raise Boom("no credentials stored")

    monkeypatch.setattr("hermes_cli.auth._read_codex_tokens", reader)
    assert providers._oauth_credentials_present("openai-codex") is False
    assert calls == ["read"]

    monkeypatch.setattr("hermes_cli.auth._read_codex_tokens",
                        lambda: {"tokens": {"access_token": "t"}})
    assert providers._oauth_credentials_present("openai-codex") is True


def test_other_oauth_providers_read_the_provider_state(monkeypatch):
    from hexbot import providers

    monkeypatch.setattr("hermes_cli.auth._load_auth_store", lambda: {})
    monkeypatch.setattr("hermes_cli.auth._load_provider_state", lambda store, slug: None)
    assert providers._oauth_credentials_present("qwen-oauth") is False

    monkeypatch.setattr("hermes_cli.auth._load_provider_state",
                        lambda store, slug: {"tokens": {"refresh_token": "r"}})
    assert providers._oauth_credentials_present("qwen-oauth") is True


def test_list_models_maps_the_picker_payload(fake_gateway):
    from hexbot import providers

    fake_gateway.responses["model.options"] = {
        "providers": [
            {"slug": "anthropic", "name": "Anthropic",
             "models": ["claude-opus-5", "claude-sonnet-5"],
             "pricing": {"claude-opus-5": {"input": "$5.00", "output": "$25.00"}}},
            {"slug": "openrouter", "name": "OpenRouter", "models": ["openai/gpt-5.6-sol"]},
        ],
        "model": "claude-opus-5", "provider": "anthropic",
    }
    payload = providers.list_models("anthropic")

    assert payload["all_source"] == "model.options"
    ids = [row["id"] for row in payload["all"]]
    assert ids == ["claude-opus-5", "claude-sonnet-5"]
    opus = payload["all"][0]
    assert opus["provider"] == "anthropic"
    assert opus["label"] == "claude-opus-5"
    assert opus["input_cost"] == "$5.00"
    assert opus["output_cost"] == "$25.00"
    assert "input_cost" not in payload["all"][1]
    assert payload["curated"] and all(row["provider"] == "anthropic" for row in payload["curated"])


def test_list_models_falls_back_to_the_offline_catalog(fake_gateway, monkeypatch):
    """An unconfigured provider comes back as an empty skeleton row."""
    from hexbot import providers

    fake_gateway.responses["model.options"] = {
        "providers": [{"slug": "xai", "name": "xAI", "models": [], "source": "canonical"}]}
    monkeypatch.setattr(providers, "_is_configured", lambda slug: False)

    payload = providers.list_models("xai")
    assert payload["all_source"] == "catalog"
    assert "grok-4.6" in [row["id"] for row in payload["all"]]
    # An unconfigured provider must be asked for with include_unconfigured.
    assert fake_gateway.params_for("model.options")[0]["include_unconfigured"] is True


def test_list_models_forwards_include_unconfigured_and_refresh(fake_gateway):
    from hexbot import providers

    fake_gateway.responses["model.options"] = {"providers": []}
    providers.list_models("anthropic", include_unconfigured=True, refresh=True)
    params = fake_gateway.params_for("model.options")[0]
    assert params == {"include_unconfigured": True, "refresh": True}


def test_list_models_survives_a_broken_picker(fake_gateway):
    from hexbot import providers
    from hexbot.errors import GatewayError

    def boom(_params):
        raise GatewayError(5033, "picker exploded")

    fake_gateway.responses["model.options"] = boom
    payload = providers.list_models("anthropic")
    assert payload["error"] == "picker exploded"
    assert payload["curated"]
    assert [row["id"] for row in payload["all"]]  # offline catalog still answers


def test_curated_table_is_well_formed():
    from hexbot.models_curated import CURATED_MODELS

    assert len(CURATED_MODELS) >= 12
    seen = set()
    for row in CURATED_MODELS:
        assert set(row) == {"provider", "id", "label"}
        assert all(isinstance(value, str) and value for value in row.values())
        assert (row["provider"], row["id"]) not in seen
        seen.add((row["provider"], row["id"]))
    providers_seen = {row["provider"] for row in CURATED_MODELS}
    assert {"openai-api", "anthropic", "xai", "openrouter", "ollama", "zai"} <= providers_seen


def test_network_addresses_deduplicate(monkeypatch):
    class Sock:
        def connect(self, target):
            pass

        def getsockname(self):
            return ("10.0.0.2", 1)

        def close(self):
            pass

    monkeypatch.setattr("socket.gethostname", lambda: "host")
    monkeypatch.setattr("socket.getaddrinfo", lambda *a: [
        (2, 1, 6, "", ("10.0.0.2", 0)),
        (2, 1, 6, "", ("127.0.0.1", 0)),
        (2, 1, 6, "", ("10.0.0.2", 0)),
        (2, 1, 6, "", ("192.168.1.5", 0)),
    ])
    monkeypatch.setattr("socket.socket", lambda *a: Sock())

    from hexbot.network import lan_addresses
    assert lan_addresses() == ["10.0.0.2", "192.168.1.5"]


def test_network_addresses_survive_a_broken_resolver(monkeypatch):
    import socket as socket_module

    def boom(*args, **kwargs):
        raise OSError("no dns")

    monkeypatch.setattr("socket.getaddrinfo", boom)

    class Sock:
        def connect(self, target):
            raise OSError("no route")

        def close(self):
            pass

    monkeypatch.setattr("socket.socket", lambda *a: Sock())
    from hexbot.network import lan_addresses
    assert lan_addresses() == []
    assert socket_module is not None


def test_network_get_and_set(monkeypatch):
    from hexbot import network

    monkeypatch.setattr(network, "lan_addresses", lambda: ["10.0.0.2"])
    monkeypatch.setenv("HEXBOT_PORT", "9131")
    assert network.get_network() == {"lan_enabled": False, "bind_host": "127.0.0.1",
                                     "port": 9131, "addresses": ["10.0.0.2"]}

    restarts = []
    monkeypatch.setattr("hexbot.serve.request_restart", lambda: restarts.append(True))
    result = network.set_network(True)
    assert result["lan_enabled"] is True
    assert result["bind_host"] == "0.0.0.0"
    assert result["restart_required"] is True
    assert restarts == [True]
