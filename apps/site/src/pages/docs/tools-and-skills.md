---
layout: ../../layouts/Docs.astro
title: Tools, connectors, and skills
description: Configure local tools, outside services, MCP servers, and skills for a Hexbot bot.
---

Tools let a bot act, connectors give it access to outside services, and skills tell it how to carry out particular work. Configure these per bot, then start a new section to use the changed tools and connectors.

## Local tools

Open Bot settings, Tools. Each switch controls one capability:

| Tool | What it does |
| --- | --- |
| Terminal | Runs shell commands on the daemon computer. |
| Files | Reads, writes, and searches files. |
| Code execution | Runs Python code for data work and checks. |
| Browser | Navigates and interacts with a configured browser. |
| Computer use | Reads the screen and acts through a configured computer-use driver. |
| Vision | Reads images you attach. |
| Voice | Speaks replies with the built-in voice; premium voice uses a connector. |
| Message other bots | Asks a named teammate for help privately. |
| Delegate | Hands a subtask to an isolated subagent. |
| Scheduling | Creates and manages reminders and recurring jobs. |

Tools execute where the daemon runs, even when you use the client app on another computer. A tool that needs something the daemon computer doesn't have is hidden from this list and from the bot until it's set up: code execution needs Python, browser needs a browser driver or a CDP address, computer use needs the cua driver, vision needs a key or endpoint for its vision model, and voice needs edge-tts or a voice provider key. Adding or removing a provider key refreshes tool availability in connected apps. A hidden tool that was switched on is switched off the next time you save the bot's tools. Full and Headless install Python for code execution and the voice tools. Neither installs Poppler: to render PDF pages, install it on the daemon computer (`brew install poppler` or `sudo apt install poppler-utils`).

The **Working directory** is the bot's workspace. Choose a project folder outside `~/.hexbot`; the daemon refuses its own data directory as a workspace. [Approvals](/docs/approvals/) explains sandbox access, network requests, and credential protection.

## Connect outside services

Open Bot settings, Connectors to configure web search, cloud browser, image and video generation, premium voice, Notion, Home Assistant, and other available services. The [tool catalog](/tools/) lists the capabilities.

An admin sets up a connector by choosing its provider and entering the requested credentials. Each bot has its own on/off switch. A connector must be ready and enabled for that bot before its tools appear in a new section.

**Connected** means an authenticated probe answered. **Key saved** means Hexbot stored the key but has not verified it with a live probe. Use the connector's test action if a service stops working, and check its reported error before replacing credentials.

Your model provider and your connectors may bill separately. A model subscription does not include an image service, browser session, or premium voice account.

## Add an MCP server

An admin can add a server in Bot settings, Connectors. Enter a name and a **Command or URL**. A command launches a local server on the daemon computer; an HTTP URL connects to a remote server. Make sure the local command and its dependencies exist on that computer.

Hexbot registers the server for the daemon and gives each bot an enable switch. Start a new section after adding or enabling it. Removing a server removes it for the deployment, so check whether another bot uses it first.

Use the server's own instructions for credentials and permissions. Its tools can act on the account you give it, and outside-service calls follow that service's rules. The workspace sandbox describes local commands; it does not limit what an authenticated service can do in its own account.

## Choose skills

Every bot draws on one shared skill library: the skills bundled with Hexbot plus any an admin adds. A skill in the library is on for every bot until it is turned off for everyone or for one bot. Open Bot settings, Skills to see a bot's skills grouped by category and turn them on or off.

A skill a bot writes for itself stays private to that bot. An admin can share a private skill from a bot they own into the library. A skill can guide a workflow, but it does not supply credentials or make a disabled tool available.

A new section lists each skill's name and description, and the bot reads the full instructions only when it needs them. Turning a skill off or editing it takes effect the next time a bot reads it, even in open sections; a skill added later appears in new sections. Read a skill's instructions before relying on it for unattended work. [Multi-user](/docs/multi-user/#skills) explains who can change what.
