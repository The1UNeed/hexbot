---
name: skill-create
description: "Write a skill: a SKILL.md with instructions for a kind of job, kept for yourself or installed as a plugin."
version: 1.0.0
author: Hexbot
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [skills, plugins, authoring]
---

# Create a skill

A skill is a short set of instructions for one kind of job: how to file a bug in this team's tracker, how to write in the user's house style, which MCP tools to call for a task. Bots see each skill's name and description and read the full text only when they need it.

## When to write one

- The user explains a process you will repeat.
- You worked something out the hard way and will need it again.
- You install an MCP server that needs know-how to use well.

Do not write a skill for a one-off task, or for facts about the user; those go in memory.

## Where it goes

- **Only for you**: `skill_manage` with a create operation. It stays in your own files, and the user sees it in your settings.
- **For other bots too, or with an MCP server**: `hexbot_plugins` with `action: "install"` and a `skills` list. It becomes a plugin the user can turn on for any bot, and it is on for you once they approve it. See the mcp skill for a server.

## How to write it

```markdown
---
description: One line that says when to use this skill. Bots choose skills by it.
---
# Title

What the skill is for, in a sentence or two.

## Steps
1. …
2. …

## Watch out for
- …
```

- Name: lowercase letters, digits, `-` or `_`, up to 64 characters, such as `release-notes`.
- The description is required and is what bots read first. Start with the job, not the tool.
- Write steps someone can follow without this conversation. Name exact tools, commands and files.
- Keep it under a page. Link to documentation rather than copying it.
- Never put keys, tokens or passwords in a skill.

Tell the user when you add a skill, and what it is for.
