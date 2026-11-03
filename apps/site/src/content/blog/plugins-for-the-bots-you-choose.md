---
title: Plugins, for the bots you choose
description: Settings has a new Plugins page. Set up a connector, MCP server, or skill once, then choose which bots get it. Bots can ask for the ones they need.
date: 2026-10-29
---

Connectors and skills used to be set up bot by bot. Yesterday's nightly changed that underneath: an MCP server is now set up once and given to the bots you choose, and new bots no longer get a copy that has lost its keys. Starting with today's nightly, you can see and manage all of it on one page.

## Settings, Plugins

The new **Plugins** page lists your connectors, MCP servers, skills, and built-in tools. Open one to add its keys, test it, choose which bots get it, or remove it. Keys show only as their last four characters. Pick a bot at the top of the page to see one switch per plugin, just for that bot.

A plugin that isn't set up yet can't be given to a bot. A skill that needs a program or key this computer lacks is kept from bots, and the page says why, such as "Needs memo installed". On the phone, Settings has one **Plugins** row in place of Connectors and Skills.

## Plugin packages

A **plugin package** installs an MCP server together with the skills that explain how to use it, or several skills at once, and removes them as one.

## Bots can ask

When a bot needs a service it can't reach, it can find an MCP server for it and ask you to install it. The card shows exactly what the server runs and every value it passes. Installing or turning on a plugin always asks you, even in Bypass, and a plugin a bot installs is on for that bot only. Your primary bot can do the same for any bot from its own chat. See [Plugins](/docs/tools-and-skills/#plugins).

## Also in this nightly

- **Instant switching over Hex Connect.** Switching bots is instant, even while they work.
- **Every stopped bot's red dot** now has a message you can read and close.
