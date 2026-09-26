"""Connectors: outside services a bot can reach, and how they map onto Hermes.

A connector is one catalog row (``CATALOG``). Setting one up writes its
credentials the way ``hexbot.providers.set_key`` does (root ``.env``, every
profile ``.env``, ``os.environ``) and, where Hermes needs a backend choice
(``web.backend``, ``image_gen.provider``, ``tts.provider``,
``browser.cloud_provider``), writes that into the root and every profile
``config.yaml``. Turning a connector on for a bot pins its toolset in the
profile's ``tools.enabled_toolsets`` (or clears the skill from
``skills.disabled``, or enables the MCP server), preserving whatever else the
profile has enabled. Field descriptions come from Hermes's own credential
catalog (``OPTIONAL_ENV_VARS``) so the two never drift.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import socket
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import dotenv_values
from dotenv import set_key as dotenv_set_key
from dotenv import unset_key
from ruamel.yaml import YAML

from hexbot import db, gateway
from hexbot.errors import GatewayError, HexbotError
from hexbot.home import hexbot_home

logger = logging.getLogger(__name__)

GROUPS = ("search", "media", "work", "social_home", "mcp")


@dataclass(frozen=True)
class Provider:
    id: str
    label: str
    keys: tuple[str, ...]
    #: ``(config section, key, value)`` Hermes reads to pick this backend.
    selection: tuple[str, str, str] | None = None


@dataclass(frozen=True)
class Spec:
    id: str
    name: str
    description: str
    group: str
    icon: str
    toolsets: tuple[str, ...] = ()
    skill: str | None = None
    keys: tuple[str, ...] = ()
    providers: tuple[Provider, ...] = ()
    #: Tool names whose failures count against this connector.
    tools: tuple[str, ...] = ()
    #: Words in an error text that point at this connector.
    mentions: tuple[str, ...] = ()
    extra_help: dict = field(default_factory=dict)


CATALOG: tuple[Spec, ...] = (
    Spec("web_search", "Web search", "Search the web and read pages.", "search", "glyph:search",
         toolsets=("web",), tools=("web_search", "web_extract"),
         mentions=("exa", "tavily", "brave", "firecrawl", "parallel", "keenable", "searxng"),
         providers=(
             Provider("exa", "Exa", ("EXA_API_KEY",), ("web", "backend", "exa")),
             Provider("tavily", "Tavily", ("TAVILY_API_KEY",), ("web", "backend", "tavily")),
             Provider("brave", "Brave Search", ("BRAVE_SEARCH_API_KEY",),
                      ("web", "backend", "brave-free")),
             Provider("firecrawl", "Firecrawl", ("FIRECRAWL_API_KEY",),
                      ("web", "backend", "firecrawl")),
             Provider("parallel", "Parallel", ("PARALLEL_API_KEY",),
                      ("web", "backend", "parallel")),
             Provider("keenable", "Keenable", ("KEENABLE_API_KEY",),
                      ("web", "backend", "keenable")),
             Provider("searxng", "SearXNG (self-hosted)", ("SEARXNG_URL",),
                      ("web", "backend", "searxng"))),
         # Hermes calls these two keys optional (keyless tiers); Hexbot needs them.
         extra_help={
             "TAVILY_API_KEY": (None, "Tavily API key for web search and extract.", None, None),
             "KEENABLE_API_KEY": (None, "Keenable API key for web search and page fetch.", None, None)}),
    Spec("cloud_browser", "Cloud browser", "Hosted browser sessions for sites that block local Chrome.",
         "search", "glyph:globe", toolsets=("browser",),
         mentions=("browserbase", "browser use", "browser-use"),
         providers=(
             Provider("browserbase", "Browserbase", ("BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"),
                      ("browser", "cloud_provider", "browserbase")),
             Provider("browser-use", "Browser Use", ("BROWSER_USE_API_KEY",),
                      ("browser", "cloud_provider", "browser-use")))),
    Spec("image_gen", "Image generation", "Make and edit images.", "media", "glyph:image",
         toolsets=("image_gen",), tools=("image_generate",), mentions=("fal", "krea"),
         providers=(
             Provider("fal", "FAL", ("FAL_KEY",), ("image_gen", "provider", "fal")),
             Provider("krea", "Krea", ("KREA_API_KEY",), ("image_gen", "provider", "krea")))),
    Spec("video_gen", "Video generation", "Generate short clips.", "media", "glyph:film",
         toolsets=("video_gen",), tools=("video_generate",), keys=("FAL_KEY",),
         mentions=("fal",)),
    Spec("premium_voice", "Premium voice", "Cloud voices for spoken replies. The built-in voice needs no account.",
         "media", "elevenlabs", toolsets=("tts",), tools=("text_to_speech",),
         mentions=("elevenlabs", "voxtral"),
         providers=(
             Provider("elevenlabs", "ElevenLabs", ("ELEVENLABS_API_KEY",),
                      ("tts", "provider", "elevenlabs")),
             Provider("openai", "OpenAI", ("VOICE_TOOLS_OPENAI_KEY",),
                      ("tts", "provider", "openai")),
             Provider("mistral", "Mistral", ("MISTRAL_API_KEY",),
                      ("tts", "provider", "mistral")))),
    Spec("notion", "Notion", "Read and write pages and databases in your workspace.", "work",
         "notion", skill="notion", keys=("NOTION_API_KEY",), mentions=("notion",)),
    Spec("airtable", "Airtable", "Read and update bases.", "work", "airtable", skill="airtable",
         keys=("AIRTABLE_API_KEY",), mentions=("airtable",)),
    Spec("x_search", "X search", "Search posts and profiles through xAI.", "social_home", "x",
         toolsets=("x_search",), tools=("x_search",), keys=("XAI_API_KEY",),
         mentions=("xai", "x.ai", "grok")),
    Spec("home_assistant", "Home Assistant", "Read sensors and call services on your home server.",
         "social_home", "homeassistant", toolsets=("homeassistant",),
         tools=("ha_list_entities", "ha_get_state", "ha_list_services", "ha_call_service"),
         keys=("HASS_URL", "HASS_TOKEN"), mentions=("home assistant", "hass"),
         extra_help={
             "HASS_URL": ("Home Assistant URL", "Where your Home Assistant answers, such as http://homeassistant.local:8123.", None, False),
             "HASS_TOKEN": ("Long-lived access token", "Profile, Security, Long-lived access tokens.", None, True)}),
)

_BY_ID = {spec.id: spec for spec in CATALOG}
_BUNDLED_SKILLS = Path(__file__).resolve().parent.parent / "skills"


# ---------------------------------------------------------------------------
# Lookups used by the incident heuristics

def spec_for(connector_id: str) -> Spec | None:
    return _BY_ID.get(connector_id)


def connector_for_tool(tool_name: str) -> str | None:
    name = (tool_name or "").strip()
    if not name:
        return None
    for spec in CATALOG:
        if name in spec.tools:
            return spec.id
    if name.startswith("mcp_"):
        for server in _root_mcp_servers():
            if name.startswith(f"mcp_{server}_") or name == f"mcp_{server}":
                return f"mcp:{server}"
    return None


def connector_mentioned(text: str) -> str | None:
    lowered = (text or "").lower()
    if not lowered:
        return None
    for spec in CATALOG:
        for key in _all_keys(spec):
            if key.lower() in lowered:
                return spec.id
    for spec in CATALOG:
        for word in spec.mentions:
            if re.search(rf"\b{re.escape(word)}\b", lowered):
                return spec.id
    return None


# ---------------------------------------------------------------------------
# Credentials

def _catalog_entry(key: str) -> dict:
    try:
        from hermes_cli.config_defaults import OPTIONAL_ENV_VARS
        return OPTIONAL_ENV_VARS.get(key) or {}
    except Exception:
        return {}


def _all_keys(spec: Spec) -> tuple[str, ...]:
    keys = list(spec.keys)
    for provider in spec.providers:
        keys.extend(provider.keys)
    return tuple(dict.fromkeys(keys))


def _profile_dirs() -> list[Path]:
    root = hexbot_home() / "profiles"
    return sorted(p for p in root.iterdir() if p.is_dir()) if root.exists() else []


def _profile_dir(bot: str) -> Path:
    from hermes_cli.profiles import get_profile_dir
    return Path(get_profile_dir(bot))


def _env_values(path: Path) -> dict:
    env = path / ".env"
    return {k: v for k, v in (dotenv_values(env) if env.exists() else {}).items() if v}


def _value(key: str, *, bot: str | None = None) -> str | None:
    if bot:
        value = _env_values(_profile_dir(bot)).get(key)
        if value:
            return value
    return _env_values(hexbot_home()).get(key) or os.environ.get(key) or None


def _write_values(values: dict, *, bot_only: str | None = None) -> None:
    targets = [_profile_dir(bot_only)] if bot_only else [hexbot_home(), *_profile_dirs()]
    for path in targets:
        env = path / ".env"
        env.parent.mkdir(parents=True, exist_ok=True)
        env.touch(mode=0o600, exist_ok=True)
        env.chmod(0o600)
        for key, value in values.items():
            dotenv_set_key(str(env), key, value)
        env.chmod(0o600)
    if not bot_only:
        os.environ.update(values)


def _clear_values(keys, *, bot_only: str | None = None) -> None:
    targets = [_profile_dir(bot_only)] if bot_only else [hexbot_home(), *_profile_dirs()]
    for path in targets:
        env = path / ".env"
        if env.exists():
            for key in keys:
                unset_key(str(env), key)
    if not bot_only:
        for key in keys:
            os.environ.pop(key, None)


def _write_config(section: str, key: str, value) -> None:
    """Set ``section.key`` in the root and every profile ``config.yaml``."""
    yaml = YAML(typ="rt")
    for path in [hexbot_home(), *_profile_dirs()]:
        target = path / "config.yaml"
        try:
            data = yaml.load(target.read_text()) if target.exists() else None
        except Exception:
            logger.warning("could not parse %s; rewriting the managed key only", target)
            data = None
        data = data if isinstance(data, dict) else {}
        block = data.get(section)
        if not isinstance(block, dict):
            block = {}
            data[section] = block
        if value is None:
            block.pop(key, None)
        else:
            block[key] = value
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("w") as stream:
            yaml.dump(data, stream)
    # Hermes caches config.yaml on (mtime, size); the rewrite above is enough.


def _read_root_config() -> dict:
    target = hexbot_home() / "config.yaml"
    try:
        data = YAML(typ="safe").load(target.read_text()) if target.exists() else None
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _selected_provider(spec: Spec) -> Provider | None:
    if not spec.providers:
        return None
    config = _read_root_config()
    for provider in spec.providers:
        section, key, value = provider.selection
        block = config.get(section)
        if isinstance(block, dict) and str(block.get(key) or "").strip().lower() == value:
            return provider
    configured = [p for p in spec.providers if all(_value(k) for k in p.keys)]
    return configured[0] if configured else None


# ---------------------------------------------------------------------------
# Per-bot enablement

def _describe(bot: str) -> dict:
    try:
        return gateway.call("profiles.describe", {"name": bot})
    except GatewayError:
        logger.debug("profiles.describe failed for %s", bot, exc_info=True)
        return {}


def _enabled_toolsets(detail: dict) -> set[str]:
    return {t.get("name") for t in detail.get("toolsets") or []
            if isinstance(t, dict) and t.get("enabled") and t.get("name")}


def _skills(detail: dict) -> dict[str, bool]:
    result = {}
    for item in detail.get("skills") or []:
        if isinstance(item, dict) and item.get("name"):
            result[str(item["name"])] = bool(item.get("enabled", True))
        elif isinstance(item, str):
            result[item] = True
    return result


def _enabled_mcp(detail: dict) -> set[str]:
    return {m.get("name") for m in detail.get("mcp_servers") or []
            if isinstance(m, dict) and m.get("enabled") and m.get("name")}


def _is_enabled(spec_id: str, detail: dict) -> bool:
    if spec_id.startswith("mcp:"):
        return spec_id[4:] in _enabled_mcp(detail)
    spec = _BY_ID[spec_id]
    if spec.skill:
        return _skills(detail).get(spec.skill, False)
    enabled = _enabled_toolsets(detail)
    if spec.id == "web_search":
        return bool(enabled & {"web", "search"})
    if spec.id == "cloud_browser":
        return "browser" in enabled and _selected_provider(spec) is not None
    return all(t in enabled for t in spec.toolsets)


def _bot_names() -> list[str]:
    db.migrate()
    with db.transaction() as conn:
        return [row["name"] for row in conn.execute("SELECT name FROM bots ORDER BY name")]


def _install_skill(bot: str, skill: str) -> None:
    """Copy the bundled skill into the profile when it is not there yet."""
    profile_skills = _profile_dir(bot) / "skills"
    if any(md.parent.name == skill for md in profile_skills.rglob("SKILL.md")) if profile_skills.exists() else False:
        return
    source = next((md.parent for md in _BUNDLED_SKILLS.rglob("SKILL.md")
                   if md.parent.name == skill), None)
    if source is None:
        raise HexbotError(4212, f"bundled skill not found: {skill}")
    shutil.copytree(source, profile_skills / source.parent.name / skill, dirs_exist_ok=True)


def _set_toolsets(bot: str, toolsets, enabled: bool) -> None:
    from hexbot.bots import pin_toolsets
    current = _enabled_toolsets(_describe(bot))
    wanted = (current | set(toolsets)) if enabled else (current - set(toolsets))
    if "web" in toolsets and not enabled:
        wanted.discard("search")
    pin_toolsets(bot, wanted)


def _set_skill(bot: str, skill: str, enabled: bool) -> None:
    if enabled:
        _install_skill(bot, skill)
    skills = _skills(_describe(bot))
    skills[skill] = enabled
    disabled = sorted(name for name, on in skills.items() if not on)
    gateway.call("profiles.configure", {"name": bot, "disabled_skills": disabled})


def _set_mcp(bot: str, server: str, enabled: bool) -> None:
    current = _enabled_mcp(_describe(bot))
    wanted = (current | {server}) if enabled else (current - {server})
    gateway.call("profiles.configure", {"name": bot, "enabled_mcp_servers": sorted(wanted)})


# ---------------------------------------------------------------------------
# MCP servers (root config.yaml is the catalog every bot draws from)

def _root_mcp_servers() -> dict:
    servers = _read_root_config().get("mcp_servers")
    return {k: v for k, v in servers.items() if isinstance(v, dict)} if isinstance(servers, dict) else {}


def _mcp_spec(name: str, entry: dict) -> dict:
    transport = "stdio"
    if entry.get("url"):
        transport = str(entry.get("transport") or "http")
    return {"name": name, "transport": transport,
            "tool_count": 0, "running": not bool(entry.get("disabled"))}


def add_mcp(name: str, *, command=None, args=None, env=None, url=None, transport=None) -> dict:
    name = (name or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", name):
        raise HexbotError(4202, "MCP server name must be letters, digits, - or _")
    if not command and not url:
        raise HexbotError(4200, "an MCP server needs a command or a url")
    entry: dict = {}
    if url:
        entry["url"] = str(url)
        if transport:
            entry["transport"] = str(transport)
    else:
        entry["command"] = str(command)
        if args:
            entry["args"] = [str(a) for a in args]
    if env:
        entry["env"] = {str(k): str(v) for k, v in dict(env).items()}
    try:
        from hermes_cli.mcp_config import validate_mcp_server_entry
        issues = validate_mcp_server_entry(name, entry)
    except Exception:
        issues = []
    if issues:
        raise HexbotError(4202, "; ".join(str(i) for i in issues))
    _write_config("mcp_servers", name, entry)
    return {"connector": get_connector(f"mcp:{name}")}


def remove_mcp(name: str) -> dict:
    servers = _root_mcp_servers()
    if name not in servers:
        raise HexbotError(4213, f"unknown MCP server: {name}")
    for bot in _bot_names():
        try:
            _set_mcp(bot, name, False)
        except GatewayError:
            logger.debug("could not disable %s for %s", name, bot, exc_info=True)
    _write_config("mcp_servers", name, None)
    return {"removed": True}


# ---------------------------------------------------------------------------
# Probes: one small, free, authenticated request per service that has one

PROBE_TIMEOUT = 6.0


def _http_get(url: str, headers: dict) -> tuple[int | None, str]:
    """``(status, reason)``; status ``None`` when the host could not be reached.
    Tests replace this; nothing else here touches the network."""
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=PROBE_TIMEOUT) as response:
            return int(response.status), ""
    except urllib.error.HTTPError as exc:
        return int(exc.code), str(exc.reason or "")
    except urllib.error.URLError as exc:
        return None, str(getattr(exc, "reason", exc) or exc)
    except (socket.timeout, TimeoutError):
        return None, "timed out"
    except (OSError, ValueError) as exc:
        return None, str(exc)


def _probe(name: str, url: str, headers: dict) -> tuple[bool, str]:
    status, reason = _http_get(url, headers)
    if status is None:
        return False, f"Could not reach {name}: {reason or 'no answer'}."
    if status in (401, 403):
        return False, f"{name} refused the token ({status})."
    if status >= 400:
        return False, f"{name} answered {status}."
    return True, "Connected."


def _probe_notion(bot):
    return _probe("Notion", "https://api.notion.com/v1/users/me",
                  {"Authorization": f"Bearer {_value('NOTION_API_KEY', bot=bot)}",
                   "Notion-Version": "2022-06-28"})


def _probe_airtable(bot):
    return _probe("Airtable", "https://api.airtable.com/v0/meta/whoami",
                  {"Authorization": f"Bearer {_value('AIRTABLE_API_KEY', bot=bot)}"})


def _probe_premium_voice(bot):
    provider = _selected_provider(_BY_ID["premium_voice"])
    if provider is None or provider.id != "elevenlabs":
        return None
    return _probe("ElevenLabs", "https://api.elevenlabs.io/v1/user",
                  {"xi-api-key": _value("ELEVENLABS_API_KEY", bot=bot) or ""})


def _probe_home_assistant(bot):
    base = (_value("HASS_URL", bot=bot) or "").rstrip("/")
    return _probe("Home Assistant", f"{base}/api/",
                  {"Authorization": f"Bearer {_value('HASS_TOKEN', bot=bot)}"})


def _probe_x_search(bot):
    return _probe("xAI", "https://api.x.ai/v1/models",
                  {"Authorization": f"Bearer {_value('XAI_API_KEY', bot=bot)}"})


#: spec id -> probe(bot) -> (ok, message) | None (None: nothing to probe right now).
_PROBES = {
    "notion": _probe_notion,
    "airtable": _probe_airtable,
    "premium_voice": _probe_premium_voice,
    "home_assistant": _probe_home_assistant,
    "x_search": _probe_x_search,
}


def _test_key(spec_id: str) -> str:
    return f"connector_test:{spec_id}"


def _save_test(spec_id: str, ok: bool, message: str, *, probed: bool) -> None:
    db.migrate()
    with db.transaction() as conn:
        conn.execute("INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)",
                     (_test_key(spec_id), json.dumps({"ok": bool(ok), "message": message,
                                                      "probed": bool(probed), "at": time.time()})))


def _last_test(spec_id: str) -> dict | None:
    db.migrate()
    with db.transaction() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key=?", (_test_key(spec_id),)).fetchone()
    if row is None:
        return None
    try:
        data = json.loads(row["value"])
    except (TypeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _forget_test(spec_id: str) -> None:
    db.migrate()
    with db.transaction() as conn:
        conn.execute("DELETE FROM settings WHERE key=?", (_test_key(spec_id),))


# ---------------------------------------------------------------------------
# Tests (cheap, offline)

def _check(fn_path: str) -> bool:
    module, _, attr = fn_path.rpartition(".")
    import importlib
    return bool(getattr(importlib.import_module(module), attr)())


_CHECKS = {
    "web_search": "tools.web_tools.check_web_api_key",
    "image_gen": "tools.image_generation_tool.check_image_generation_requirements",
    "video_gen": "tools.video_generation_tool.check_video_generation_requirements",
    "premium_voice": "tools.tts_tool.check_tts_requirements",
    "x_search": "tools.x_search_tool.check_x_search_requirements",
}


def _run_check(spec_id: str) -> bool | None:
    """Hermes's own offline requirement check, or None when there is none."""
    path = _CHECKS.get(spec_id)
    if path is None:
        return None
    try:
        return _check(path)
    except Exception:
        logger.debug("requirement check failed for %s", spec_id, exc_info=True)
        return False


def _required_keys(spec: Spec) -> tuple[str, ...]:
    provider = _selected_provider(spec)
    return provider.keys if provider else spec.keys


def _is_ready(spec: Spec, *, bot: str | None = None) -> bool:
    required = _required_keys(spec)
    return bool(required) and all(_value(k, bot=bot) for k in required)


def _scoped_bot() -> str | None:
    """The bot whose profile Hermes is resolving tools for, if any."""
    from hermes_constants import get_hermes_home
    home = Path(get_hermes_home())
    return home.name if home.parent.name == "profiles" else None


def gate_tools() -> None:
    """Hide every connector tool from the model until its connector is set up.

    Hermes's own checks pass without one (keyless web search, another
    provider's credential), so each tool in ``Spec.tools`` also has to pass
    ``_is_ready``. Runs once, when the plugin registers; built-in tools are
    in the registry by then.
    """
    from tools.registry import registry
    for spec in CATALOG:
        gates = {}
        for name in spec.tools:
            entry = registry.get_entry(name)
            if entry is None or getattr(entry.check_fn, "hexbot_gate", False):
                continue
            inner = entry.check_fn
            if inner not in gates:
                def gate(spec=spec, inner=inner):
                    return _is_ready(spec, bot=_scoped_bot()) and (inner is None or bool(inner()))
                gate.hexbot_gate = True
                gates[inner] = gate
            entry.check_fn = gates[inner]


def _tools_changed() -> None:
    from tools.registry import invalidate_check_fn_cache
    invalidate_check_fn_cache()


def test_connector(connector_id: str, *, bot: str | None = None) -> dict:
    if connector_id.startswith("mcp:"):
        entry = _root_mcp_servers().get(connector_id[4:])
        if entry is None:
            return {"ok": False, "message": "This MCP server is not defined."}
        return {"ok": not entry.get("disabled"), "message": "Defined." if not entry.get("disabled") else "Disabled."}
    spec = _BY_ID.get(connector_id)
    if spec is None:
        raise HexbotError(4213, f"unknown connector: {connector_id}")
    missing = [k for k in _required_keys(spec) if not _value(k, bot=bot)]
    if not _required_keys(spec):
        return {"ok": False, "message": "Choose a provider first."}
    if missing:
        return {"ok": False, "message": f"Missing {', '.join(missing)}."}
    verdict = _run_check(spec.id)
    if verdict is False:
        result = {"ok": False,
                  "message": f"{spec.name} is set up but Hexbot cannot use it yet. Check the value."}
        _save_test(spec.id, probed=False, **result)
        return result
    probe = _PROBES.get(spec.id)
    outcome = probe(bot) if probe else None
    if outcome is None:
        result = {"ok": True, "message": "Key saved."}
        _save_test(spec.id, probed=False, **result)
        return result
    ok, message = outcome
    result = {"ok": bool(ok), "message": message}
    _save_test(spec.id, probed=True, **result)
    return result


# ---------------------------------------------------------------------------
# Shapes

def _field(spec: Spec, key: str, *, bot: str | None, provider: str | None = None) -> dict:
    entry = _catalog_entry(key)
    label, help_text, url, secret = spec.extra_help.get(key, (None, None, None, None))
    value = _value(key, bot=bot)
    return {
        "key": key,
        "provider": provider,
        "label": label or entry.get("prompt") or key.replace("_", " ").title(),
        "help": help_text or entry.get("description") or "",
        "url": url or entry.get("url"),
        "secret": bool(entry.get("password", True)) if secret is None else secret,
        "advanced": bool(entry.get("advanced")) and key not in spec.keys,
        "set": bool(value),
        "hint": f"…{value[-4:]}" if value and len(value) >= 8 else None,
    }


def _shape(spec: Spec, *, bot: str | None, details: dict[str, dict], open_errors: dict) -> dict:
    provider = _selected_provider(spec)
    ready = _is_ready(spec, bot=bot)
    error = open_errors.get(spec.id)
    last = _last_test(spec.id) if ready else None
    if error:
        state, state_text = "error", error["text"].split("\n")[0][:80]
    elif ready and last and not last.get("ok"):
        state, state_text = "error", str(last.get("message") or "The last test failed.")[:80]
    elif ready:
        state = "ready"
        # "Connected" is a claim; only a probe that answered may make it.
        state_text = "Connected" if last and last.get("probed") else "Key saved"
        if provider:
            state_text += f" · {provider.label}"
    else:
        state, state_text = "not_set_up", "Not set up"
    # Every provider's fields, tagged, so a client can show the right ones
    # before a selection is saved; ``provider: None`` marks fields common to all.
    fields = [_field(spec, key, bot=bot) for key in spec.keys]
    for option in spec.providers:
        fields.extend(_field(spec, key, bot=bot, provider=option.id) for key in option.keys)
    return {
        "id": spec.id, "name": spec.name, "description": spec.description,
        "group": spec.group, "icon": spec.icon, "scope": "daemon",
        "state": state, "state_text": state_text,
        "providers": [{"id": p.id, "label": p.label,
                       "configured": all(_value(k) for k in p.keys)} for p in spec.providers] or None,
        "provider": provider.id if provider else None,
        "fields": fields,
        "enabled_for_bot": _is_enabled(spec.id, details[bot]) if bot else None,
        "enabled_bots": [name for name, detail in details.items() if _is_enabled(spec.id, detail)],
        "last_error": {"text": error["text"], "at": error["created_at"]} if error else None,
    }


def _shape_mcp(name: str, entry: dict, *, bot: str | None, details=None, open_errors=None) -> dict:
    details = details or {}
    error = (open_errors or {}).get(f"mcp:{name}")
    spec_id = f"mcp:{name}"
    return {
        "id": spec_id, "name": name,
        "description": entry.get("url") or " ".join([str(entry.get("command", "")), *[str(a) for a in entry.get("args") or []]]).strip(),
        "group": "mcp", "icon": "glyph:server", "scope": "daemon",
        "state": "error" if error else ("not_set_up" if entry.get("disabled") else "ready"),
        "state_text": error["text"][:80] if error else ("Disabled" if entry.get("disabled") else "Running"),
        "providers": None, "provider": None, "fields": [],
        "enabled_for_bot": _is_enabled(spec_id, details[bot]) if bot and bot in details else None,
        "enabled_bots": [n for n, d in details.items() if _is_enabled(spec_id, d)],
        "last_error": {"text": error["text"], "at": error["created_at"]} if error else None,
        "mcp": _mcp_spec(name, entry),
    }


def _open_errors() -> dict[str, dict]:
    db.migrate()
    with db.transaction() as conn:
        rows = conn.execute(
            "SELECT connector, text, created_at FROM bot_incidents WHERE resolved_at IS NULL "
            "AND kind='connector_error' AND connector IS NOT NULL ORDER BY created_at DESC").fetchall()
    result = {}
    for row in rows:
        result.setdefault(row["connector"], {"text": row["text"], "created_at": row["created_at"]})
    return result


def list_connectors(bot: str | None = None) -> dict:
    names = _bot_names()
    if bot and bot not in names:
        raise HexbotError(4205, f"bot not found: {bot}")
    details = {name: _describe(name) for name in names}
    open_errors = _open_errors()
    rows = [_shape(spec, bot=bot, details=details, open_errors=open_errors) for spec in CATALOG]
    rows.extend(_shape_mcp(name, entry, bot=bot, details=details, open_errors=open_errors)
                for name, entry in sorted(_root_mcp_servers().items()))
    return {"connectors": rows}


def get_connector(connector_id: str, bot: str | None = None) -> dict:
    for row in list_connectors(bot)["connectors"]:
        if row["id"] == connector_id:
            return row
    raise HexbotError(4213, f"unknown connector: {connector_id}")


# ---------------------------------------------------------------------------
# Mutations

def set_for_bot(connector_id: str, bot: str, enabled: bool) -> dict:
    _apply_for_bot(connector_id, bot, enabled)
    return {"connector": get_connector(connector_id, bot)}


def _apply_for_bot(connector_id: str, bot: str, enabled: bool) -> None:
    """Turn a connector on or off for one bot without reshaping the catalog."""
    if bot not in _bot_names():
        raise HexbotError(4205, f"bot not found: {bot}")
    if connector_id.startswith("mcp:"):
        if connector_id[4:] not in _root_mcp_servers():
            raise HexbotError(4213, f"unknown MCP server: {connector_id[4:]}")
        _set_mcp(bot, connector_id[4:], bool(enabled))
    else:
        spec = _BY_ID.get(connector_id)
        if spec is None:
            raise HexbotError(4213, f"unknown connector: {connector_id}")
        if spec.skill:
            _set_skill(bot, spec.skill, bool(enabled))
        elif spec.id == "cloud_browser":
            # The local browser stays a Tool; the cloud provider only needs its
            # selection. Off means "back to local Chrome".
            if not enabled:
                _write_config("browser", "cloud_provider", None)
        else:
            _set_toolsets(bot, spec.toolsets, bool(enabled))


def setup(connector_id: str, values: dict | None, *, provider=None, bot=None,
          enable_for_bot=None, bot_only=False) -> dict:
    if connector_id.startswith("mcp:"):
        raise HexbotError(4202, "MCP servers are added with connectors.add_mcp")
    spec = _BY_ID.get(connector_id)
    if spec is None:
        raise HexbotError(4213, f"unknown connector: {connector_id}")
    if bot and bot not in _bot_names():
        raise HexbotError(4205, f"bot not found: {bot}")
    if bot_only and not bot:
        raise HexbotError(4200, "bot_only needs a bot")
    values = {str(k): str(v).strip() for k, v in (values or {}).items() if str(v or "").strip()}
    chosen = None
    if spec.providers:
        chosen = next((p for p in spec.providers if p.id == (provider or "")), None)
        if chosen is None and not provider:
            chosen = next((p for p in spec.providers if all(k in values for k in p.keys)), None) \
                or _selected_provider(spec)
        if chosen is None:
            raise HexbotError(4202, f"choose a provider: {', '.join(p.id for p in spec.providers)}")
    allowed = set(_all_keys(spec))
    unknown = set(values) - allowed
    if unknown:
        raise HexbotError(4201, f"unknown field: {sorted(unknown)[0]}")
    if values:
        if spec.id == "x_search" and "XAI_API_KEY" in values and not bot_only:
            from hexbot.providers import set_key
            set_key("xai", values.pop("XAI_API_KEY"))
        if values:
            _write_values(values, bot_only=bot if bot_only else None)
    if chosen is not None:
        section, key, value = chosen.selection
        _write_config(section, key, value)
    _tools_changed()
    result = test_connector(spec.id, bot=bot)
    if result["ok"]:
        from hexbot.incidents import resolve
        resolve(connector=spec.id)
        if bot and (enable_for_bot is None or enable_for_bot):
            _apply_for_bot(spec.id, bot, True)
    return {"connector": get_connector(spec.id, bot), "test": result}


def clear(connector_id: str, *, bot=None, bot_only=False) -> dict:
    if connector_id.startswith("mcp:"):
        raise HexbotError(4202, "MCP servers are removed with connectors.remove_mcp")
    spec = _BY_ID.get(connector_id)
    if spec is None:
        raise HexbotError(4213, f"unknown connector: {connector_id}")
    if bot_only and not bot:
        raise HexbotError(4200, "bot_only needs a bot")
    # A key another connector still runs on (FAL_KEY serves image and video
    # generation) stays; only this connector's selection and switches go.
    shared = {k for other in CATALOG if other.id != spec.id
              for k in _required_keys(other) if _value(k, bot=bot)}
    keys = [k for k in _all_keys(spec) if k != "XAI_API_KEY" and k not in shared]
    _clear_values(keys, bot_only=bot if bot_only else None)
    if not bot_only:
        _forget_test(spec.id)
    if spec.providers and not bot_only:
        section, key, _ = spec.providers[0].selection
        _write_config(section, key, None)
    _tools_changed()
    if not bot_only:
        for name in _bot_names():
            try:
                if _is_enabled(spec.id, _describe(name)):
                    _apply_for_bot(spec.id, name, False)
            except (GatewayError, HexbotError):
                logger.debug("could not disable %s for %s", spec.id, name, exc_info=True)
    return {"connector": get_connector(spec.id, bot)}


def list_skills(bot: str) -> dict:
    """Installed skills for a bot with the SKILL.md description and category."""
    if bot not in _bot_names():
        raise HexbotError(4205, f"bot not found: {bot}")
    enabled = _skills(_describe(bot))
    root = _profile_dir(bot) / "skills"
    result = []
    seen = set()
    if root.exists():
        for md in sorted(root.rglob("SKILL.md")):
            name = md.parent.name
            if name in seen:
                continue
            seen.add(name)
            meta = _frontmatter(md)
            category = md.parent.parent.name if md.parent.parent != root else ""
            result.append({"name": name, "description": str(meta.get("description") or ""),
                           "category": category, "enabled": enabled.get(name, True)})
    for name, on in enabled.items():
        if name not in seen:
            result.append({"name": name, "description": "", "category": "", "enabled": on})
    result.sort(key=lambda item: (item["category"], item["name"]))
    return {"skills": result}


def _frontmatter(path: Path) -> dict:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end < 0:
        return {}
    try:
        data = YAML(typ="safe").load(text[3:end])
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}
