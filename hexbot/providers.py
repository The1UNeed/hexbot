"""Provider credentials and model-picker projections."""

from __future__ import annotations

import logging
import os
from pathlib import Path

from dotenv import set_key as dotenv_set_key
from dotenv import unset_key

from hexbot import gateway
from hexbot.errors import HexbotError
from hexbot.home import hexbot_home
from hexbot.models_curated import CURATED_MODELS

logger = logging.getLogger(__name__)

#: Slugs callers reach for that Hermes spells differently. Applied BEFORE the
#: Hermes alias tables because ``hermes_cli.providers.normalize_provider``
#: resolves "openai" to "openrouter", which is not what a client asking for
#: "the OpenAI provider" means.
_ALIASES = {
    "openai": "openai-api",
    "gpt": "openai-api",
    "chatgpt": "openai-codex",
    "codex": "openai-codex",
    "claude": "anthropic",
    "grok": "xai",
    "glm": "zai",
    "z.ai": "zai",
    "z-ai": "zai",
}


def canonical_provider(name: str | None) -> str:
    """Best-effort canonical Hermes slug for a caller-supplied provider name."""
    slug = (name or "").strip().lower()
    if not slug:
        return ""
    if slug in _ALIASES:
        return _ALIASES[slug]
    try:
        from providers import get_provider_profile
        profile = get_provider_profile(slug)
        if profile is not None:
            return profile.name
    except Exception:
        logger.debug("provider registry lookup failed for %s", slug, exc_info=True)
    return slug


def _profile_dirs() -> list[Path]:
    root = hexbot_home() / "profiles"
    return sorted(p for p in root.iterdir() if p.is_dir()) if root.exists() else []


def _registry_profile(slug: str):
    try:
        from providers import get_provider_profile
        return get_provider_profile(slug)
    except Exception:
        return None


def _auth_config(slug: str):
    try:
        from hermes_cli.auth import PROVIDER_REGISTRY
        return PROVIDER_REGISTRY.get(slug)
    except Exception:
        return None


def _env_vars(slug: str) -> tuple[str, ...]:
    profile = _registry_profile(slug)
    if profile is not None and profile.env_vars:
        return tuple(profile.env_vars)
    config = _auth_config(slug)
    if config is not None and config.api_key_env_vars:
        return tuple(config.api_key_env_vars)
    return ()


def _auth_type(slug: str) -> str:
    profile = _registry_profile(slug)
    if profile is not None and profile.auth_type:
        return profile.auth_type
    config = _auth_config(slug)
    return config.auth_type if config is not None else "api_key"


def _label(slug: str) -> str:
    """Human display name: providers/ registry, else the Hermes label table."""
    profile = _registry_profile(slug)
    if profile is not None and (profile.display_name or "").strip():
        return profile.display_name.strip()
    try:
        from hermes_cli.providers import get_label
        label = (get_label(slug) or "").strip()
        if label and label != slug:
            return label
    except Exception:
        logger.debug("get_label failed for %s", slug, exc_info=True)
    config = _auth_config(slug)
    if config is not None and (config.name or "").strip():
        return config.name.strip()
    return slug.replace("-", " ").title()


def _oauth_credentials_present(slug: str) -> bool:
    """Cheap, offline check for a stored OAuth grant.

    ``openai-codex`` has a dedicated reader (``_read_codex_tokens``) that raises
    ``AuthError`` when nothing is stored. Every other external-OAuth provider
    keeps its grant in the same ``auth.json`` store, so a direct provider-state
    read answers the same question without a network round trip.
    """
    try:
        from hermes_cli import auth
    except Exception:
        return False
    if slug == "openai-codex":
        try:
            return bool((auth._read_codex_tokens() or {}).get("tokens"))
        except Exception:
            return False
    try:
        state = auth._load_provider_state(auth._load_auth_store(), slug) or {}
    except Exception:
        return False
    tokens = state.get("tokens")
    return bool(
        (isinstance(tokens, dict) and (tokens.get("access_token") or tokens.get("refresh_token")))
        or state.get("api_key")
        or state.get("access_token")
    )


def _known_slugs() -> list[str]:
    """Every provider Hermes can route to, canonical picker order first."""
    slugs: list[str] = []
    try:
        from hermes_cli.models import CANONICAL_PROVIDERS
        slugs.extend(entry.slug for entry in CANONICAL_PROVIDERS)
    except Exception:
        logger.debug("CANONICAL_PROVIDERS unavailable", exc_info=True)
    try:
        from providers import list_providers as registry
        slugs.extend(profile.name for profile in registry())
    except Exception:
        logger.debug("provider registry unavailable", exc_info=True)
    seen: set[str] = set()
    ordered = []
    for slug in slugs:
        if slug not in seen:
            seen.add(slug)
            ordered.append(slug)
    return ordered


def list_providers() -> list[dict]:
    """All Hermes providers with a real ``configured`` boolean."""
    from dotenv import dotenv_values

    values = dotenv_values(hexbot_home() / ".env")
    result = []
    for slug in _known_slugs():
        env_vars = _env_vars(slug)
        auth_type = _auth_type(slug)
        first = env_vars[0] if env_vars else None
        configured = bool(first and (os.environ.get(first) or values.get(first)))
        if not configured and auth_type.startswith("oauth"):
            configured = _oauth_credentials_present(slug)
        profile = _registry_profile(slug)
        result.append({
            "id": slug,
            "label": _label(slug),
            "configured": configured,
            "auth_type": auth_type,
            "models_source": "live" if (profile is not None and profile.models_url) else "registry",
        })
    return result


def _key_env_var(provider: str) -> tuple[str, str]:
    slug = canonical_provider(provider)
    env_vars = _env_vars(slug)
    if not env_vars:
        if _registry_profile(slug) is None and _auth_config(slug) is None:
            raise HexbotError(4206, f"unknown provider: {provider}")
        raise HexbotError(
            4207, f"provider has no API-key environment variable: {provider}")
    return slug, env_vars[0]


def set_key(provider: str, key: str) -> dict:
    """Write the provider's key into the root .env and every bot profile's .env."""
    slug, env_name = _key_env_var(provider)
    for path in [hexbot_home(), *_profile_dirs()]:
        env = path / ".env"
        env.touch(mode=0o600, exist_ok=True)
        env.chmod(0o600)
        dotenv_set_key(str(env), env_name, key)
        env.chmod(0o600)
    os.environ[env_name] = key
    return {"provider": slug, "configured": True}


def clear_key(provider: str) -> dict:
    slug, env_name = _key_env_var(provider)
    for path in [hexbot_home(), *_profile_dirs()]:
        env = path / ".env"
        if env.exists():
            unset_key(str(env), env_name)
    os.environ.pop(env_name, None)
    return {"provider": slug, "configured": False}


def _context_window(slug: str, model_id: str):
    try:
        from agent.models_dev import lookup_models_dev_context
        return lookup_models_dev_context(slug, model_id, allow_network=False)
    except Exception:
        return None


def _model(slug: str, model_id: str, pricing: dict | None) -> dict:
    entry = {"provider": slug, "id": model_id, "label": model_id}
    context = _context_window(slug, model_id)
    if context:
        entry["context"] = context
    price = (pricing or {}).get(model_id) or {}
    # ``model.options`` pre-formats prices as "$3.00" per million tokens (or
    # "free"); they are passed through verbatim so every Hexbot surface reads
    # the same string the Hermes picker shows.
    if price.get("input"):
        entry["input_cost"] = price["input"]
    if price.get("output"):
        entry["output_cost"] = price["output"]
    return entry


def _rows_from_options(payload: dict) -> list[dict]:
    rows = payload.get("providers")
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def _static_catalog(slug: str) -> list[str]:
    """Offline curated ids for a provider, used when the live picker has none."""
    try:
        from hermes_cli.models import _PROVIDER_MODELS, OPENROUTER_MODELS
    except Exception:
        return []
    if slug == "openrouter":
        return [model_id for model_id, _ in OPENROUTER_MODELS]
    return list(_PROVIDER_MODELS.get(slug, []))


def list_models(provider=None, include_unconfigured=None, refresh=False) -> dict:
    """Return ``{curated, all}`` model lists, optionally filtered by provider.

    ``all`` comes from the Hermes ``model.options`` picker payload. That payload
    only carries model ids for providers that already have credentials —
    unconfigured providers appear as empty skeleton rows — so when the caller
    names a provider with no key we ask for ``include_unconfigured`` and, if the
    row is still empty, fall back to Hermes' offline curated catalog. ``refresh``
    forwards the picker's live-catalog refresh.
    """
    slug = canonical_provider(provider)
    curated = [dict(row) for row in CURATED_MODELS
               if not slug or canonical_provider(row["provider"]) == slug]
    if include_unconfigured is None:
        include_unconfigured = bool(slug) and not _is_configured(slug)
    params = {"include_unconfigured": bool(include_unconfigured), "refresh": bool(refresh)}
    try:
        payload = gateway.call("model.options", params)
    except Exception as exc:
        logger.warning("model.options failed: %s", exc)
        fallback = _catalog_models(slug)
        return {"curated": curated, "all": fallback,
                "all_source": "catalog" if fallback else "none", "error": str(exc)}

    models: list[dict] = []
    sources: set[str] = set()
    for row in _rows_from_options(payload):
        row_slug = str(row.get("slug") or "")
        if slug and canonical_provider(row_slug) != slug:
            continue
        ids = [m for m in (row.get("models") or []) if isinstance(m, str)]
        source = "model.options"
        if not ids:
            ids = _static_catalog(row_slug)
            source = "catalog" if ids else ""
        if not ids:
            continue
        sources.add(source)
        pricing = row.get("pricing") if isinstance(row.get("pricing"), dict) else {}
        models.extend(_model(row_slug, model_id, pricing) for model_id in ids)

    if slug and not models:
        models = _catalog_models(slug)
        if models:
            sources.add("catalog")
    all_source = sources.pop() if len(sources) == 1 else ("mixed" if sources else "none")
    return {"curated": curated, "all": models, "all_source": all_source}


def _catalog_models(slug: str) -> list[dict]:
    return [_model(slug, model_id, None) for model_id in _static_catalog(slug)] if slug else []


def _is_configured(slug: str) -> bool:
    from dotenv import dotenv_values

    env_vars = _env_vars(slug)
    if env_vars:
        values = dotenv_values(hexbot_home() / ".env")
        if os.environ.get(env_vars[0]) or values.get(env_vars[0]):
            return True
    return _auth_type(slug).startswith("oauth") and _oauth_credentials_present(slug)
