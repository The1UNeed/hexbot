# Hexbot

## Glossary

Use these words consistently in code, UI copy, docs, and commit messages.

- **Hexbot**: the product. Not "Hexybot" (typo). Package and CLI name `hexbot`, home directory `~/.hexbot`.
- **Daemon**: the Hexbot server process (hard fork of Hermes Agent) that runs bots, rooms, memory, tools, and serves the WebSocket API and the web UI.
- **Full package**: the desktop app running with a local daemon. **Client-only**: the same app connected to a daemon elsewhere.
- **Bot**: a named agent with its own persona, model, skills, and section memory. Implemented as one Hermes profile, multiplexed in one daemon process.
- **Section** = **conversation** = **thread**: one persistent chat with a bot or inside a room. These three words mean the same thing. A section lives until the user archives or deletes it. Each section is its own Hermes session with its own context window.
- **Room**: a group chat with one or more humans and any number of bots. May have an optional **main bot** that responds when nobody is @-mentioned.
- **Core memory**: memory shared by all of a user's bots. Bots write to it only through an explicit action.
- **Section memory**: a bot's private memory, including its notes and searchable history over its own sections and the rooms it belongs to. Archiving a section keeps it in memory; deleting purges it and the memory entries derived from it.
- **Dreaming**: a bot's daily pass over that day's conversations that summarises them into its section memory.
- **Auto mode**: the approval mode that lets a small model auto-approve low-risk tool actions. Hermes calls it `smart`. The other modes are Manual (default) and Off.
- **Hex Connect**: Hexbot's optional cloud service at hexbot.app for reaching a daemon from outside the LAN, authenticated with Clerk. LAN pairing never depends on it.
