---
name: skill-creator
description: "Write or improve a skill: a SKILL.md that teaches you, or other bots, one kind of job you will do again."
version: 2.0.0
author: Hexbot
license: MIT
---

# Write a skill

A skill is a folder with a `SKILL.md` and, when needed, scripts and reference files. Every bot that has it sees its name and description in its prompt and reads the rest only when a task calls for it. So a skill costs almost nothing until it is used, and the description decides whether it ever is.

## When to write one

- The user explains a process you will repeat, such as how their team files bugs or writes release notes.
- You worked something out the hard way and will need it again.
- An MCP server needs know-how to use well.

Don't write one for a one-off task, for facts about the user (those go in memory), or for something you already do well without instructions. Check `skills_list` first: improve a skill you have rather than adding a second one for the same job. Skills built into Hexbot can't be changed or copied under their name.

## 1. Start from real examples

Before writing, get two or three concrete requests the skill should handle, from the conversation or by asking the user. Note what a good result looked like and where you went wrong without the skill. Those examples decide what goes in.

## 2. Write the description first

It is the only part a bot sees before choosing the skill. One sentence, under 200 characters, that says what the job is and when to use it, in the words a user would say:

- Good: `Write release notes from merged pull requests in the team's format.`
- Too vague: `Helps with documentation.`
- Too narrow: `Run scripts/notes.py.`

## 3. Write the body

```markdown
---
description: When to use this skill, in one sentence.
---
# Title

What the skill is for, in a sentence or two.

## Steps
1. …

## Watch out for
- …
```

- Only what a capable bot would not know: the team's conventions, the exact tool or command, the order that works, the mistakes to avoid. Leave out general knowledge.
- Steps someone can follow without this conversation. Name exact tools, commands and paths.
- Say why when a rule is not obvious; a bot follows a reason better than a bare "always".
- Keep `SKILL.md` under about 300 lines. Move long material, such as an API reference or a template, into `references/` and say in the body when to read it. Put code that would be rewritten every time into `scripts/`.
- No secrets. Never put keys, tokens or passwords in a skill; Settings holds them.
- Name: lowercase letters, digits, `-` or `_`, up to 64 characters, such as `release-notes`.

## 4. Save it

- **For you**: `skill_manage` with a `create` operation (`name`, `content`, and `category` if you like). Add more files with `write_file` (`file_path`, `file_content`), under `references/`, `templates/`, `scripts/` or `assets/`. It stays in your files, and the user sees it in your settings.
- **For other bots, or with an MCP server**: `hexbot_plugins` with `action: "install"` and a `skills` list. The user approves it on a card and chooses its bots; read the mcp skill for a server.

## 5. Test and improve

Try the skill on one of your examples: read it with `skill_view` as a bot would, follow it, and compare the result with what the user wanted. Fix what was unclear with `skill_manage` `patch`. When the user corrects you on a task a skill covers, update the skill so the correction lasts.

Tell the user when you add or change a skill, and what it is for, in one line.
