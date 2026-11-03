---
title: Connect a plugin right from the chat
description: When a bot needs a key to use a plugin, it now asks with a card in its chat. What you type is saved and tested, and the bot never sees it.
date: 2026-11-02
---

Ask HexBot to set up Notion, and until today it would tell you the connector needs your API token, then send you off to Settings to paste it. Starting with today's nightly, it asks for the token right there in the chat.

## Cards for plugins

When a bot needs a plugin, it shows a **plugin card** with the plugin's icon, name, and one line about it:

- **Install** shows exactly what an MCP server runs, with a field for any key it still needs.
- **Turn on** asks for the keys a plugin you already have is missing.
- **Connect** asks for the keys alone. For web search, you also pick the provider.

What you type goes to the daemon and nowhere else. It's saved the same way Settings, Plugins saves it. Then Hexbot tests the plugin and tells the bot whether it works. The key never reaches the model, the chat history, or a log.

## A tidier Sign in card

The card a bot shows when it needs a [password](/blog/passwords-your-bots-never-see/) gets the same look: the site's name and a **Sign in** button that opens the fields. Once the login is in Passwords, the card says **Saved**.

Both cards work in the app, the browser, and on the phone. Signing in with a service's own page instead of a key is not available yet. See [Plugins](/docs/tools-and-skills/#plugins) and [Passwords](/docs/passwords/).
