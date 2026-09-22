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
