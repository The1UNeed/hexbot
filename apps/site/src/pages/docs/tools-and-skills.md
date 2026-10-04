---
layout: ../../layouts/Docs.astro
title: Tools, connectors, and skills
description: Configure local tools, outside services, MCP servers, and skills for a Hexbot bot.
---

Tools let a bot act, connectors give it access to outside services, and skills tell it how to carry out particular work. Configure these per bot, then start a new section to use the changed tool and skill setup.

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

Tools execute where the daemon runs, even when you use the client app on another computer. Enabling a tool does not install every dependency it needs. Browser and computer use need their configured browser or driver. A standalone daemon also needs Python for code execution and Poppler for PDF page rendering. Full app setup manages its bundled runtime and code and voice dependencies.

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

Open Bot settings, Skills to see installed instructions grouped by category. Installed skills are enabled unless you turn them off. A skill can guide a workflow, but it does not supply credentials or make a disabled tool available.

Full packages include bundled skills. A bot can also use its skill tools to find or install more when those tools are available. Read a skill's instructions before relying on it for unattended work, and start a new section after changing the selection.
