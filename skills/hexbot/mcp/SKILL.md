---
name: mcp
description: "Find an MCP server for a service you can't reach yet, and install it as a plugin with hexbot_plugins."
version: 1.0.0
author: Hexbot
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [MCP, plugins, tools, setup]
---

# Install an MCP server

Use this when the user wants you to work with a service, such as GitHub, Linear or a database, and none of your plugins reaches it. An MCP server gives you that service's tools. You install it as a plugin with `hexbot_plugins`, and the user approves it first.

## 1. Check what is already there

Call `hexbot_plugins` with `action: "list"`. If a plugin for the service exists but is off for you, use `action: "enable"` with its `id`, such as `package:github` or `connector:mcp:linear`, instead of installing another one. If it is a connector that is not set up, ask the user to set it up in Settings, Plugins; you never handle its keys.

## 2. Find the server

Prefer, in this order:

1. The service's own MCP server, from its documentation. Many offer a hosted streamable HTTP address, such as `https://mcp.linear.app/mcp`.
2. The reference servers at https://github.com/modelcontextprotocol/servers and the MCP registry at https://registry.modelcontextprotocol.io.
3. A well-maintained community package with recent releases. Read its README before you choose it.

Hexbot runs servers two ways:

- **Command**: a program the daemon starts on this computer, such as `npx -y @modelcontextprotocol/server-github` or `uvx mcp-server-fetch`. The command and its runtime (Node for `npx`, uv for `uvx`) must already be installed there.
- **URL**: a streamable HTTP server elsewhere. SSE-only servers are not supported; use the server's HTTP address.

Servers that sign in with OAuth in a browser can't be installed this way. If the service offers a token, use that instead.

## 3. Install it

Call `hexbot_plugins` with `action: "install"`:

```json
{
  "action": "install",
  "name": "github",
  "description": "GitHub issues, pull requests and code search",
  "mcp": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": {"GITHUB_PERSONAL_ACCESS_TOKEN": ""}
  },
  "skills": [
    {"name": "github-issues", "content": "---\ndescription: File, find and triage GitHub issues with the github plugin.\n---\n# GitHub issues\n..."}
  ]
}
```

- `name`: lowercase letters, digits, `-` or `_`. The server's tools appear as `mcp__<name>__<tool>`.
- For a URL server, give `"mcp": {"url": "https://…", "headers": {"Authorization": ""}}`.
- **Leave secret values empty.** Never put a token you were not given in the plugin, and never ask the user to paste one in the chat. They fill empty values in Settings, Plugins.
- Add a skill when the server needs know-how: which tools to call, in what order, and what to avoid. Read the skill-create skill for how to write one. Keep it short.

The user sees what the plugin runs and approves or declines it. If they decline, do not try again with another server unless they ask; ask what they would like instead.

## 4. After installing

- The plugin is on for you only. Its tools reach you from your next message, in your codemode scripts: use `searchTools()` or `describeNamespace("mcp__<name>")` to find them.
- Read the plugin's skills with `skill_view` straight away.
- If the reply says the plugin still needs values, tell the user exactly which ones and where: Settings, Plugins, then the plugin's name.
- Tell the user what you installed, in one line.
