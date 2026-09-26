# Hexbot CLI Reference

Live sources when anything looks stale: `hexbot core --help`, `hexbot core <command> --help`,
https://hermes-agent.nousresearch.com/docs/reference/cli-commands

### Global Flags

```
hexbot core [flags] [command]      (no subcommand = interactive chat)

  --version, -V             Show version
  -z, --oneshot PROMPT      One-shot: print ONLY the final response (for scripts/pipes)
  -m MODEL  --provider P    Model/provider override for this invocation
  -t, --toolsets LIST       Comma-separated toolsets for this invocation
  --resume, -r SESSION      Resume session by ID or title
  --continue, -c [NAME]     Resume by name, or most recent session
  --worktree, -w            Isolated git worktree mode (parallel agents)
  --skills, -s SKILL        Preload skills (comma-separate or repeat)
  --profile, -p NAME        Use a named profile
  --yolo                    Skip dangerous command approval
  --tui / --cli             Force the Ink TUI / classic REPL
  --ignore-rules            Skip AGENTS.md/SOUL.md/memory/skill injection
  --safe-mode               Disable ALL customizations (troubleshooting)
  --pass-session-id         Include session ID in system prompt
```

### Chat

```
hexbot core chat [flags]
  -q, --query TEXT          Single query, non-interactive
  --image PATH              Attach a local image to a single query
  -Q, --quiet               Suppress banner, spinner, tool previews
  --checkpoints             Enable filesystem checkpoints (/rollback)
  --max-turns N             Cap tool-calling iterations
  --source TAG              Session source tag (default: cli)
```
(plus the global flags above)

### Configuration

```
hexbot core setup [section]      Wizard (model|tts|terminal|gateway|tools|agent)
hexbot core model                Interactive model/provider picker
hexbot core fallback [add|remove|list]  Fallback provider chain
hexbot core config [show|edit|get|set|unset|path|env-path|check|migrate]
hexbot core login / logout       OAuth sign-in / clear stored auth
hexbot core doctor [--fix]       Check dependencies and config
hexbot core status [--all]       Component status
```

### Tools & Skills

```
hexbot core tools [list|enable NAME|disable NAME]   Per-platform toolsets (curses UI with no args)

hexbot core skills list|browse|search QUERY|inspect ID
hexbot core skills install ID    Hub identifier OR a direct https://…/SKILL.md URL
hexbot core skills config        Enable/disable skills per platform
hexbot core skills check|update|uninstall|publish PATH
hexbot core skills tap add REPO  Add a GitHub repo as a skill source
hexbot core bundles              Skill bundles (one /<name> alias loads several skills)
```

### MCP Servers

```
hexbot core mcp add NAME (--url or --command) | remove | list | test NAME
hexbot core mcp catalog | install NAME     Curated catalog install
hexbot core mcp configure NAME             Toggle tool selection
hexbot core mcp serve                      Run Hexbot as an MCP server
```
Details (transport, tool discovery, catalog): `references/native-mcp.md`.

### Gateway (Messaging Platforms)

```
hexbot core gateway run|install|start|stop|restart|status|setup
```

20+ platforms: Telegram, Discord, Slack, WhatsApp (Baileys + Business Cloud API), iMessage (Photon — `hexbot core photon setup`), Signal, Email, SMS, Matrix, Mattermost, Teams, LINE, SimpleX, ntfy, Google Chat, Home Assistant, DingTalk, Feishu, WeCom, Weixin, API Server, Webhooks. Open WebUI connects via the API Server adapter. Most adapters ship under `plugins/platforms/`.
Docs: https://hermes-agent.nousresearch.com/docs/user-guide/messaging/

### Sessions

```
hexbot core sessions list|browse|rename ID TITLE|delete ID|export OUT|prune|stats
```

### Cron / Webhooks

```
hexbot core cron list|create SCHED|edit ID|pause|resume|run ID|remove|status
    Schedules: '30m', 'every 2h', '0 9 * * *', ISO timestamp
hexbot core webhook subscribe NAME|list|remove NAME|test NAME
```
Webhook payloads/routes: `references/webhooks.md`.

### Profiles

```
hexbot core profile list|create NAME (--clone|--clone-all|--clone-from)|use|show|delete
hexbot core profile rename A B | alias NAME | export NAME | import FILE
```

### Credentials & Pools

```
hexbot core auth                 Interactive credential manager
hexbot core auth add [PROVIDER]  Add OAuth or API-key credential (nous, openai-codex, qwen-oauth, …)
hexbot core auth list|remove P IDX|reset PROVIDER|status
```
Multiple credentials per provider form a pool that rotates automatically and skips exhausted keys.

### Other

```
hexbot core desktop / gui        Native desktop app
hexbot core dashboard            Web admin panel + embedded chat (--stop / --status)
hexbot core proxy                OpenAI-compatible local proxy backed by an OAuth provider
hexbot core portal               Quick setup / sign in via Nous Portal
hexbot core kanban <verb>        Multi-agent work-queue board
hexbot core project              Named multi-folder workspaces
hexbot core skin list|use|set    Switch/tweak skins (see references/themes.md)
hexbot core pets <verb>          Pet mascots (see references/petdex.md)
hexbot core memory setup|status|off|reset   Memory provider
hexbot core secrets bitwarden|onepassword   External secret stores
hexbot core moa                  Mixture-of-Agents slots
hexbot core hooks / security / backup / import / checkpoints / console
hexbot core logs [-f] [errors]   View agent/error logs
hexbot core send                 One-off message through a gateway platform
hexbot core pairing / plugins / insights / journey / computer-use
hexbot core acp                  ACP server (IDE integration)
hexbot core completion bash|zsh|fish
hexbot core update / uninstall / claw migrate
```

Plugin- and provider-supplied subcommands (e.g. `hexbot core photon setup`) only appear once their plugin is installed/active.

### Where to Find Things

| Looking for... | Location |
|---|---|
| Config options | `hexbot core config edit` · [Configuration docs](https://hermes-agent.nousresearch.com/docs/user-guide/configuration) |
| Tools / toolsets | `hexbot core tools list` · [Tools reference](https://hermes-agent.nousresearch.com/docs/reference/tools-reference) |
| Skills catalog | `hexbot core skills browse` · [Skills catalog](https://hermes-agent.nousresearch.com/docs/reference/skills-catalog) |
| Provider setup | `hexbot core model` · [Providers guide](https://hermes-agent.nousresearch.com/docs/integrations/providers) |
| Env variables | `hexbot core config env-path` · [Env vars reference](https://hermes-agent.nousresearch.com/docs/reference/environment-variables) |
| Gateway logs | `~/.hexbot/logs/gateway.log` (or `hexbot core logs`) |
| Sessions | `hexbot core sessions browse` (reads state.db) |
