"""Bundled backend plugin entry point."""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def _register_about_you(ctx) -> None:
    """Inject the session owner's About you text as one prompt section.

    The text is capped at ``USER_CAP`` (2000), well inside the registrar's
    4000-character section allowance.
    """
    from hexbot.memory import PROMPT_SECTION_ID, render_user_memory

    ctx.register_system_prompt_section(PROMPT_SECTION_ID, render_user_memory,
                                       position="after_memory")


def _register_activity_hook(ctx) -> None:
    """Stamp section + bot activity when a turn's stream finishes, and keep
    the bot's incidents in step with it.

    ``on_stream_end`` carries ``session_id`` from ``AIAgent.session_id``, which
    is the *stored* session key (== the Hexbot section id), not the gateway's
    live session id. Resolution goes through
    ``hexbot.sections.section_for_session``, which accepts either flavour.
    A finished stream closes the section's ``turn_failed`` incident; a stream
    that ended with an error (other than the user stopping it) opens one,
    which the client shows as the Stopped card.
    """
    def touch_completed_section(*, session_id="", finished=False, error=None, **_kwargs):
        if not session_id:
            return
        try:
            from hexbot import incidents
            from hexbot.sections import section_for_session, touch_section
            row = section_for_session(str(session_id))
            if row is None:
                return
            if finished:
                # Each streamed LLM call ends here, so only the turn's own
                # failure is closed; a connector incident raised by a tool call
                # a moment earlier must outlive the model's follow-up stream.
                touch_section(row["id"])
                incidents.resolve(section_id=row["id"], kind="turn_failed")
            elif error and not incidents.is_interrupt(str(error)):
                incidents.record(row["bot"], "turn_failed", str(error), section_id=row["id"],
                                 session_id=str(session_id))
        except Exception:
            logger.debug("could not stamp section activity", exc_info=True)

    ctx.register_hook("on_stream_end", touch_completed_section)


def connector_incident(*, tool_name="", result=None, status=None, error_message=None,
                       session_id="", **_kwargs) -> None:
    """``post_tool_call``: a connector refusing a tool call opens an incident."""
    try:
        from hexbot import incidents
        verdict = incidents.classify_tool_result(
            tool_name, result, status=status, error_message=error_message)
        if verdict is None or not session_id:
            return
        connector, text = verdict
        from hexbot.sections import section_for_session
        section = section_for_session(str(session_id))
        bot = section["bot"] if section else None
        room_id = None
        if bot is None:
            from hexbot import db
            with db.transaction() as conn:
                row = conn.execute(
                    "SELECT room_id,bot FROM room_sessions WHERE stored_session_id=? "
                    "OR live_session_id=? LIMIT 1", (session_id, session_id)).fetchone()
            if row:
                room_id, bot = row["room_id"], row["bot"]
        if not bot:
            return
        incidents.record(bot, "connector_error", text, connector=connector,
                         section_id=section["id"] if section else None, room_id=room_id,
                         session_id=str(session_id))
    except Exception:
        logger.debug("could not record connector incident", exc_info=True)


def _register_dream_hooks(ctx) -> None:
    from hexbot.dreaming import current_dream, finish_turn

    ctx.register_hook("post_tool_call", connector_incident)

    def finish_dream(*, assistant_response="", **kwargs):
        finish_turn(assistant_response or "", **kwargs)

    def fail_unfinished_dream(**kwargs):
        dream = current_dream(**kwargs)
        if dream:
            finish_turn("Dream turn did not complete.", status="failed", **kwargs)

    ctx.register_hook("post_llm_call", finish_dream)
    ctx.register_hook("on_session_end", fail_unfinished_dream)


def register(ctx):
    if hasattr(ctx, "register_dashboard_auth_provider") and not _auth_provider_registered():
        from hexbot.auth_provider import HexbotAuthProvider
        ctx.register_dashboard_auth_provider(HexbotAuthProvider())
    else:
        logger.warning("Hexbot auth requires a newer Hermes PluginContext")
    if not hasattr(ctx, "register_rpc_method"):
        logger.warning("Hexbot RPC requires a newer Hermes PluginContext")
        return
    from hexbot.rpc import register as register_rpc

    _register_about_you(ctx)
    if hasattr(ctx, "register_hook"):
        _register_activity_hook(ctx)
        _register_dream_hooks(ctx)
    if hasattr(ctx, "register_tool"):
        from hexbot.activity import SCHEMA, message_bot
        ctx.register_tool(name="message_bot", toolset="hexbot", schema=SCHEMA,
                          handler=message_bot)
        from hexbot.dreaming import DIGEST_SCHEMA, dream_digest
        ctx.register_tool(name="hexbot_dream_digest", toolset="hexbot",
                          schema=DIGEST_SCHEMA, handler=dream_digest)
        # Its own toolset, never listed in ``known_plugin_toolsets``, so Hermes
        # keeps it on for every bot regardless of the Tools page.
        from hexbot.soul import SCHEMA as SOUL_SCHEMA, soul_tool
        ctx.register_tool(name="hexbot_soul", toolset="hexbot-soul", schema=SOUL_SCHEMA,
                          handler=soul_tool)
    from hexbot.connectors import gate_tools
    gate_tools()
    # Constructing the singleton performs restart reconciliation, then starts
    # the room supervisor. No Hermes lifecycle code needs to know about it.
    from hexbot.rooms import get_engine
    get_engine()
    if not _rpc_registered():
        register_rpc(ctx)


def _rpc_registered() -> bool:
    """Hermes builds one plugin manager per profile home; the RPC table is
    process-global, so only the first manager registers the methods."""
    from hermes_cli.plugins import lookup_plugin_rpc_method

    return lookup_plugin_rpc_method("hexbot.info") is not None


def _auth_provider_registered() -> bool:
    try:
        from hermes_cli.dashboard_auth.registry import list_providers

        return any(getattr(p, "name", "") == "hexbot" for p in list_providers())
    except Exception:  # pragma: no cover - registry shape changes
        return False
