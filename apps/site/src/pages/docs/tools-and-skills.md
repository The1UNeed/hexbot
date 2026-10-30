---
layout: ../../layouts/Docs.astro
title: Tools, plugins, and skills
description: Configure local tools, connectors, MCP servers, and skills for your Hexbot bots.
---

Tools let a bot act on the daemon computer. Plugins are everything else a bot can use: connectors reach services Hexbot supports, MCP servers reach anything else, and skills tell a bot how to carry out particular work. Changed tools and plugins apply from your next message in the bot's chat; that one reply costs more than usual because it cannot reuse the provider's prompt cache.

## Plugins

Open Settings, Plugins to see every connector, MCP server, skill, and built-in tool that needs a program (Computer use, Browser, Code execution) on one page. Open a plugin to choose the bots that get it, set it up, test it, or remove it. To work through one bot's plugins, choose the bot at the top of the page: each plugin then shows a switch for that bot. A plugin that isn't set up can be taken from bots but not given to them until it is. Bot settings, Connectors and Skills show the same plugins for one bot.

## Local tools

Open Bot settings, Tools. Each switch controls one capability:

| Tool | What it does |
| --- | --- |
| Terminal | Runs shell commands on the daemon computer. |
| Files | Reads, writes, and searches files. |
| Code execution | Runs Python code for data work and checks. |
| Browser | Navigates and interacts with a configured browser. |
| Computer use | Lets the bot work on your bots' shared computer, a Linux desktop it clicks and types in, which you can watch and take over. |
| Vision | Reads images you attach. |
| Voice | Speaks replies with the built-in voice; premium voice uses a connector. |
| Message other bots | Asks a named teammate for help privately. |
| Delegate | Hands a subtask to an isolated subagent. |
| Scheduling | Creates and manages reminders and recurring jobs. |

Tools execute where the daemon runs, even when you use the client app on another computer. A tool that needs something the daemon computer doesn't have is hidden from this list and from the bot until it's set up: code execution needs Python, browser needs a browser driver or a CDP address, computer use needs [Cua](https://cua.ai) and Docker, vision needs a key or endpoint for its vision model, and voice needs edge-tts or a voice provider key. Adding or removing a provider key refreshes tool availability in connected apps. A hidden tool that was switched on is switched off the next time you save the bot's tools. Full and Headless install Python for code execution and the voice tools. Neither installs Poppler: to render PDF pages, install it on the daemon computer (`brew install poppler` or `sudo apt install poppler-utils`).

### Your bots' computer

Your bots share one computer: a Cua sandbox, a Linux desktop with a browser and a terminal, running in Docker on the daemon computer. It is made the first time a bot with Computer use needs it, and it is separate from your computer and from the bots' workspaces. Install Cua there with `uv tool install cua` and start Docker; the first start downloads the computer, a few GB.

Open the side panel's Computer tab to watch the screen live; on the phone, tap the computer button at the top of a bot's chat. Each bot that works on it has a cursor with its face, which moves to where it clicks and types, and the line under the screen says who is doing what. Bots take turns one action at a time. If something goes wrong, choose **Take control**: the screen opens large and takes your clicks and keys, and the bots wait until you choose **Give back**. The tab's menu restarts the computer, turns it off, or resets it to a fresh one. It also sets the screen's quality on this device: **Auto**, the default, streams as sharp and smooth as your connection allows and drops to no less than 720p at 30 fps when it is slow; or hold 1080p or 720p at 60 or 30 fps. The phone has the same choice on the computer card. The screen plays only over a secure connection: through Hex Connect, or in Hexbot on the daemon computer. A phone or app paired at a plain `http://` address on your network says so instead of showing it. Bot settings, Tools sets its size (small, medium or large); a new size applies after Reset. Without the app, `hexbot computer` shows it, and `on`, `off`, `restart`, `reset`, `give-back` and `size` change it.

The **Working directory** is the bot's workspace. Choose a project folder outside `~/.hexbot`; the daemon refuses its own data directory as a workspace. [Approvals](/docs/approvals/) explains sandbox access, network requests, and credential protection.

## Connect outside services

Connectors are the services Hexbot supports: web search, cloud browser, image and video generation, premium voice, Notion, Home Assistant, and others. The [tool catalog](/tools/) lists the capabilities.

You set up a connector in Settings, Plugins, or in Bot settings, Connectors, by choosing its provider and entering the requested credentials. Each bot has its own on/off switch. A connector must be ready and enabled for that bot before its tools appear in the bot's chat.

**Connected** means an authenticated probe answered. **Key saved** means Hexbot stored the key but has not verified it with a live probe. Use the connector's test action if a service stops working, and check its reported error before replacing credentials.

Your model provider and your connectors may bill separately. A model subscription does not include an image service, browser session, or premium voice account.

## Add an MCP server

Add a server in Settings, Plugins, or in Bot settings, Connectors. Enter a name and a **Command or URL**. A command launches a local server on the daemon computer; an HTTP URL connects to a remote server. Make sure the local command and its dependencies exist on that computer. Servers that sign in through a browser (OAuth) and SSE-only servers are not supported.

From Settings, Plugins, add a line on what the server is for and, if your bots need know-how to use it, a skill: which tools to call, in what order, and what to avoid. The server and its skill are installed together as one package, given to every bot. Then open the server to add the values it needs: environment values for a command, headers such as `Authorization` for a URL. Values stay on the daemon, and Hexbot shows only their last four characters. A server with an empty value shows **Needs** and the value's name. Removing a package removes its server and skills for every bot.

Hexbot registers the server once for the daemon. A server you add from a bot's settings goes to that bot; give it to other bots with their own switches or with `hexbot plugins assign connector mcp:NAME BOT ...`. A new bot starts with no servers. The bot's chat can use a server from your next message after you add or enable it. Removing a server removes it for every bot, so check whether another bot uses it first.

Use the server's own instructions for credentials and permissions. Its tools can act on the account you give it, and outside-service calls follow that service's rules. The workspace sandbox describes local commands; it does not limit what an authenticated service can do in its own account.

## When a bot asks for a plugin

A bot that needs a service it can't reach yet can find an MCP server for it and ask to install it, guided by the bundled `mcp` skill. You see what the server runs, every value it passes, and the skills it adds, and approve or decline. Hexbot asks every time, even in Bypass, and a scheduled job can't install anything. A bot can't hand a server your stored keys. A plugin a bot installs is on for that bot only, also when you add bots later. If it needs a token, the bot leaves the value empty and tells you where to fill it in.

A bot can also ask to turn on a plugin that is off for it, which asks you the same way, and turn one off for itself without asking. Your primary bot can do all of this for any of your bots from its own chat, and remove packages, always asking first.

## Choose skills

Every bot draws on one shared skill library: the skills bundled with Hexbot plus any you add. A skill in the library is on for every bot until it is turned off for everyone or for one bot. Open Bot settings, Skills to see a bot's skills grouped by category and turn them on or off.

Some skills need something on the daemon's computer first: a program such as `imsg` or `himalaya`, a key such as `NOTION_API_KEY`, or a particular operating system. Until it is there, the skill is hidden from bots, and Bot settings, Skills says what it needs. Install the program or save the key, and the skill appears for bots that have it on.

A skill a bot writes for itself stays private to that bot. You can share a private skill from a bot into the library. A bot can also put skills in a package, which asks you first; the bundled `skill-create` skill shows it how. A skill can guide a workflow, but it does not supply credentials or make a disabled tool available.

The chat lists each skill's name and description, and the bot reads the full instructions only when it needs them. Turning a skill off or editing it takes effect the next time a bot reads it; a skill added later appears in the list after the chat next summarises older messages. Read a skill's instructions before relying on it for unattended work.
