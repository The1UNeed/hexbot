def test_kickoff_prompt_is_shaped_by_the_bot():
    from hexbot.kickoff import KICKOFF_MARKER, kickoff_prompt

    plain = kickoff_prompt({"display_name": "Scout", "title": "", "description": ""})
    assert plain.startswith(f'{KICKOFF_MARKER} "Scout".')
    assert "described you as" not in plain
    assert "fit the name (" in plain
    assert "hexbot_soul" in plain and "memory tool" in plain
    assert "USER" not in plain

    described = kickoff_prompt({"display_name": "Scout", "title": "Research lead",
                                "description": "Finds sources fast"})
    assert "The user described you as: Research lead. Finds sources fast" in described
    assert "fit the name and that description" in described

    assert kickoff_prompt({"display_name": " "}).startswith(f'{KICKOFF_MARKER} "this bot".')


def test_kickoff_keeps_non_ascii_names():
    from hexbot.kickoff import KICKOFF_MARKER, kickoff_prompt

    assert kickoff_prompt({"display_name": "Zoë"}).startswith(f'{KICKOFF_MARKER} "Zoë".')


def test_kickoff_marker_matches_the_client():
    """The client filters a replayed kickoff out of history by the same marker."""
    import re
    from pathlib import Path

    from hexbot.kickoff import KICKOFF_MARKER

    source = Path(__file__).resolve().parents[2] / "apps/web/src/lib/bot-kickoff.ts"
    match = re.search(r"KICKOFF_MARKER = '([^']+)'", source.read_text())
    assert match and match.group(1) == KICKOFF_MARKER
