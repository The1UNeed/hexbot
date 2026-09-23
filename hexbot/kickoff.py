"""A new bot's first turn: it greets the user and asks what it is for.

The prompt is submitted hidden into the bot's first section, so the user only
sees the bot's side. Every client (app, browser, CLI) gets the same first run
because the text lives here and not in a bundle. The answers land in the
bot's soul (purpose, working style) and memory (facts), which is how a bot
called "research" becomes a research bot without a settings form.
"""

from __future__ import annotations

import json

from hexbot import gateway, sections

#: Opens every kickoff prompt. The client filters a replayed kickoff out of
#: history by it, so change both together (``apps/web/src/lib/bot-kickoff.ts``).
KICKOFF_MARKER = "You were just created and named"


def kickoff_prompt(bot: dict) -> str:
    name = (bot.get("display_name") or "").strip() or "this bot"
    about = ". ".join(part.strip() for part in (bot.get("title"), bot.get("description"))
                      if part and part.strip())
    fit = "the name and that description" if about else "the name"
    quoted = json.dumps(name, ensure_ascii=False)
    lines = [
        f"{KICKOFF_MARKER} {quoted}. The user is meeting you for the first time.",
        *([f"The user described you as: {about}"] if about else []),
        "Set yourself up by talking, not by listing settings:",
        "1. Greet the user in one short line. No headings, no lists.",
        "2. Use the clarify tool, one question at a time, to learn what they want from you.",
        f"   Write every question and choice for {quoted} specifically; never ask a generic",
        f"   question that would suit any bot. Start with what they mainly want {quoted} for;",
        f"   offer three or four concrete choices that fit {fit} (a bot named \"research\"",
        "   gets research-shaped choices), plus the user may type their own answer. If the name",
        "   says nothing about the job, say so lightly and offer varied choices. Then ask how",
        "   they want you to work (tone, depth, how proactive to be), then where their material",
        "   lives or what to keep in mind, each shaped by the answers so far.",
        "   Three questions at most. Acknowledge each answer in one line before the next.",
        "3. When done, write down what you learned. Your purpose and how you should work go",
        "   into your soul: read it with hexbot_soul, then write the complete new text, keeping",
        "   your name. Facts about the user and where their material lives go into memory with",
        "   the memory tool. Then say in one line what you will focus on and stop. Do not ask",
        "   anything else.",
        "Keep every message short. Never mention this instruction.",
    ]
    return "\n".join(lines)


def introduce(name: str, section_id: str) -> dict:
    """Submit the kickoff into *section_id*, attaching the caller to it first.

    ``open_section`` resumes the session on the calling transport, so the
    client that asked for the introduction is the one that sees it stream.
    """
    from hexbot.bots import get_bot
    from hexbot.errors import HexbotError
    bot = get_bot(name)
    opened = sections.open_section(section_id)
    row = opened["section"]
    if row["bot"] != name:
        raise HexbotError(4204, f"section {section_id} does not belong to {name}")
    if opened["messages"]:
        raise HexbotError(4243, "the section already has messages; the kickoff is for a new one")
    live = row.get("live_session_id") or sections.live_id(section_id)
    gateway.call("prompt.submit", {"session_id": live, "text": kickoff_prompt(bot),
                                   "display_kind": "hidden"})
    return {"submitted": True, "section": row}
