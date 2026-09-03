"""Bundled backend plugin entry point."""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def _register_core_memory(ctx) -> None:
    """Register one prompt section per core memory section.

    Hermes caps a *single* plugin system-prompt section at 4000 characters
    (``hermes_cli.plugins.MAX_SYSTEM_PROMPT_SECTION_CHARS``), so the whole of
    core memory registered as one section was silently truncated to a quarter
    of its budget. Four sections, one per core memory section, each get their
    own 4000-char allowance.

    Order is stable: ``PluginManager.render_system_prompt_sections`` iterates
    ``sorted(section_ids)``, so the blocks always render as household, rules,
    user, workspace. Each block repeats the "Core memory" title so a reader can
    place it regardless of where it lands.
    """
    from hexbot.memory import CORE_CAP, CORE_SECTIONS, core_section_renderer, section_prompt_id

    for section in CORE_SECTIONS:
        ctx.register_system_prompt_section(
            section_prompt_id(section),
            core_section_renderer(section),
            position="after_memory",
            max_chars=CORE_CAP,
        )


def _register_activity_hook(ctx) -> None:
    """Stamp section + bot activity when a turn's stream finishes.

    ``on_stream_end`` carries ``session_id`` from ``AIAgent.session_id``, which
    is the *stored* session key (== the Hexbot section id), not the gateway's
    live session id. Resolution goes through
    ``hexbot.sections.section_for_session``, which accepts either flavour.
    """
    def touch_completed_section(*, session_id="", finished=False, **_kwargs):
        if not finished or not session_id:
            return
        try:
            from hexbot.sections import section_for_session, touch_section
            row = section_for_session(str(session_id))
            if row is not None:
                touch_section(row["id"])
        except Exception:
            logger.debug("could not stamp section activity", exc_info=True)

    ctx.register_hook("on_stream_end", touch_completed_section)


def register(ctx):
    if hasattr(ctx, "register_dashboard_auth_provider"):
        from hexbot.auth_provider import HexbotAuthProvider
        ctx.register_dashboard_auth_provider(HexbotAuthProvider())
    else:
        logger.warning("Hexbot auth requires a newer Hermes PluginContext")
    if not hasattr(ctx, "register_rpc_method"):
        logger.warning("Hexbot RPC requires a newer Hermes PluginContext")
        return
    from hexbot.rpc import register as register_rpc

    _register_core_memory(ctx)
    if hasattr(ctx, "register_hook"):
        _register_activity_hook(ctx)
    register_rpc(ctx)
