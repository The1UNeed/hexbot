# Bot settings: two levels

Status: phases 1 and 2 implemented (window, panel, status in the chat,
connectors). Channels, Spotify, and the skills hub are still to come.
Mockups: https://claude.ai/code/artifact/6430c704-4d70-4363-adf8-affcef0ccfb8

## The problem

The right panel is the only place to change a bot. It holds identity
fields, a Shareable switch, seven sub-pages behind chevrons, and Delete,
all in a 300 px column. Three things go wrong:

1. Everything is one level deep, so nothing is more important than
   anything else. The persona editor and the delete action sit in the
   same list.
2. Wide things are squeezed. Memory (four core sections plus notes plus
   dreaming) and Model (two selects with long labels) need room.
3. Most of what Hermes can do is missing. The Tools page shows five
   switches. Hermes ships web search across seven providers, image and
   video generation, X search, voice, Notion, Linear, Airtable, Home
   Assistant, Spotify, twenty-odd messaging channels, MCP servers, and a
   skills hub. None of it is reachable from Hexbot, and a bot cannot be
   given any of it.

## Principles

- **Two levels, not one.** The panel is a glance. The window is where
  work happens. Nothing is duplicated between them; the panel links
  into the window.
- **Set up where you need it.** A connector that is not set up shows a
  Set up button in the bot's own settings. The sheet that opens saves
  the key once for the daemon and turns the connector on for this bot.
  Nobody is sent to another screen to come back later.
- **One word for one thing.** Tools are what a bot can do on this
  computer with no account. Connectors are anything that reaches an
  outside service or server. Skills are instructions. Hermes words
  (toolset, platform, env var, MCP) stay internal.
- **Silent save, loud failure.** Fields save on blur and switches on
  change, as today. Errors show inline beside the control. No Save
  button, no toast.
- **Status is a property of the bot.** Whether a bot is idle, working,
  waiting on a human, or stopped is computed by the daemon and shown in
  three places: the roster dot, a card in the chat, and a native
  notification.

## Level 1: the right panel

Width unchanged. Contents, top to bottom:

- Face (click for the Bot / Upload picker, as today).
- Name, label chip, model name in one muted line.
- Name, Label (optional), Description fields. Saved on blur.
- **Notify me.** A per-bot switch: native notifications when this bot
  stops or needs you. Approval notifications exist already; this
  extends them to Stopped and to room waiting states, and lets a user
  silence a chatty bot without silencing all of them.
- **Bot settings** button, with a muted line naming what is inside.

Gone from the panel: Shareable (moves to Profile in the window), the
seven sub-pages, Delete bot (moves to Advanced). Status is not in the
panel either; it lives in the chat (below). The panel header shows the
bot's name instead of "Settings".

## Status in the chat

The transcript already carries two of the four states: the face and
status line above a reply while the bot works, and the approval card
when it needs a decision. The design adds the third and leaves the
fourth alone:

| State | Where it shows | Actions |
| --- | --- | --- |
| Idle | Nowhere in the chat. The roster row shows the last-active time. | |
| Working | The existing status line above the reply. | Stop |
| Needs you | The existing approval card, the "Waiting on you" room banner. | Approve, Deny, Always allow |
| Stopped | A new inline card at the point of failure: red dot, "<bot> stopped", why, which task did not finish. | Fix <connector>, Retry |

The Stopped card stays in the transcript after the fix, marked with the
outcome, the same way an approval card does. "Fix <connector>" opens
the window on Connectors with that connector's set-up sheet already
open. A "Retry" resends the last user message.

While a bot is Needs you or Stopped in a section that is not open, the
roster row shows the amber or red dot, and the notification (if the
bot's Notify me switch is on) opens that section.

## Level 2: the Bot settings window

Same dialog as global Settings (76 rem by 56 rem, 208 px left tabs,
content column capped at 48 rem). Route `/b/$bot/settings/$tab` so a
page is a link: the Stopped card, the conversation header, and error
rows can all deep-link. Closing returns to the section that was open.

Tabs, in order:

1. **Profile.** Face, name, label, description, Shareable.
2. **Persona.** Full-height editor. Role templates as a menu that
   replaces the text after confirming. Word count.
3. **Model.** Provider and model, curated list pinned on top as today,
   with room for the model's description and price per million tokens.
4. **Memory.** This bot's notes and user notes, dreaming (enabled, may
   write core, last and next run, Dream now, recent dreams). Core
   memory is shared by all bots and moves out to Settings, Memory;
   this page links to it. Today the core editor appears inside every
   bot's Memory tab, which reads as if each bot had its own.
5. **Tools.** Switches grouped as Computer (terminal, files, code
   execution, browser, computer use), Senses (vision, built-in voice),
   Working with others (message other bots, delegate, scheduling), and
   the Workspace working directory. A tool with a missing prerequisite
   shows what to install instead of a switch.
6. **Connectors.** See below.
7. **Skills.** Installed skills with switches, grouped by category,
   with a search over the skills hub and one-click install. The
   current free-text "Attach a skill" field goes away.
8. **Approvals.** Inherit the daemon default, or override to Manual,
   Auto, or Off for this bot, with the same three descriptions as
   global Settings.
9. **Sections.** As today, with room for the last-active time and
   archived sections in their own group.
10. **Advanced.** Daily token budget, and Delete bot with the
    type-the-name confirmation.

The Computer sub-page (working directory plus tool activity) is not a
setting. The directory moves to Tools, Workspace. Tool activity is
already in the transcript as collapsed step lines; the panel does not
need a second copy.

## Connectors

### The model

A connector is one row in a catalog that Hexbot owns
(`hexbot/connectors.py`). Each entry names:

- `id`, `name`, `description`, `group`, `icon`.
- `scope`: `daemon` (an API key shared by every bot, like a provider
  key) or `bot` (a token that is the bot's own identity, like a
  Telegram bot token).
- `fields`: the credentials and options to collect, taken from Hermes's
  `OPTIONAL_ENV_VARS` in `hermes_cli/config_defaults.py` (description,
  where to get it, secret or not, advanced or not). That catalog is
  already the schema Hermes's own setup uses; Hexbot reads it rather
  than retyping it.
- `enables`: what turning it on for a bot means in Hermes terms, one or
  more of: a toolset in `tools.enabled_toolsets`, a skill left out of
  `skills.disabled`, an MCP server entry, or a platform under
  `platform_toolsets`.
- `test`: how to prove it works (the toolset's `check_fn`, or one cheap
  call).

The first catalog, by group:

| Group | Connectors |
| --- | --- |
| Search and browsing | Web search (provider choice: Exa, Tavily, Brave, Firecrawl, Parallel, Keenable, SearXNG), Cloud browser (Browserbase, Browser Use) |
| Images and voice | Image generation (FAL, Krea, OpenAI, xAI), Video generation, Premium voice (ElevenLabs, OpenAI, Mistral) |
| Notes and work | Notion, Linear, Airtable |
| Social and home | X search, Home Assistant, Spotify |
| Channels (bot scope) | Telegram, Discord, Slack, WhatsApp, Signal, iMessage, Matrix, Mattermost, and the rest Hermes ships, each with its allowed-users list |
| MCP servers | Any number, added by command or URL, with a tool count and a running state |

Web search is a connector, not a tool, because it needs a provider
account. Image generation is the same. The rule is the one in
Principles: does it work offline with no account.

### Icons

Brand connectors (Notion, Linear, Airtable, X, Telegram, Discord,
Slack, Home Assistant, Spotify, ElevenLabs, GitHub, and the other
channels) use the Simple Icons glyphs (CC0), bundled as SVG under
`apps/web/src/assets/connectors/` and drawn white on the brand colour
in a 28 px rounded square. Capability rows that front several providers
(web search, cloud browser, image and video generation) use a neutral
Lucide glyph on a Hexbot colour, since no single brand owns them. MCP
servers use the server glyph unless the catalog entry names a brand.
Simple Icons has no glyph for Exa, FAL, Krea, Tavily, Firecrawl, or
Browserbase; those providers appear as text in the row's status and
never need an icon of their own.

### The page

Search field, filter chips (All, On for this bot, Needs setup,
Channels), then the groups. Each row: icon, name, one-line description,
state in words, and one control:

- Set up when the daemon has no credentials. Opens the sheet.
- A switch when it is set up. On means this bot can use it.
- Fix, in red, when the last use failed with an authentication or
  quota error. Opens the sheet with the failing field marked.

Clicking the row (not the control) expands it to show the fields it
uses, when it was last used by this bot, and Advanced options.

### The set-up sheet

A dialog over the window (the mockup shows Notion). Fields from the
catalog, a line saying where to get the value, the scope in plain
words ("Stored once on this daemon. Every bot you turn it on for uses
it."), a Turn on for <bot> switch defaulted on, and for daemon-scoped
connectors an Advanced switch, Use a different token for this bot
only, which writes to the bot's own profile `.env` instead. Hermes
profiles each have an `.env`, so this costs nothing new.

Connect and test saves, runs the test, and shows the result in the
sheet before it closes. A failed test keeps the sheet open with the
message under the field.

### Where credentials live

Daemon-scoped values go in the daemon's `.env` as Hermes expects, so
`hermes` CLI commands run against the same install see them.
Bot-scoped values go in the bot's profile `.env`. Global Settings gets
a Connectors tab that is the same catalog without the per-bot switch,
for administrators who want to set everything up before making bots.

## Status and notifications

Add to the bot record: `status` (`idle`, `working`, `needs_you`,
`stopped`), `status_detail` (`text`, `section_id`, `since`, and an
optional `action` such as `{kind: "fix_connector", id: "notion"}`),
and `notify` (boolean, default on).

The daemon computes status from signals it already has:

- `working`: a live session in `working` or `starting` for one of the
  bot's sections.
- `needs_you`: a pending approval request, a live session in `waiting`,
  or a room `waiting.human` event whose bot is this one.
- `stopped`: a room turn with `status = failed`, a `limit.tripped`
  event, a dream with `status = failed`, or a tool call that failed
  with an authentication or quota error from a connector. The last one
  needs the tool layer to tag the error with the connector id; that
  tag is what makes Fix <connector> possible.
- `idle`: none of the above.

Status rides on `hexbot.bots.changed`, so the roster and panel update
without polling. The client sends a native notification on a
transition into `needs_you` or `stopped` when `notify` is on. Approval
notifications already exist; this generalises them.

## Actions and how they are reached

| Intent | Where | How |
| --- | --- | --- |
| Rename, relabel, describe | Panel | Type, blur |
| See what a bot is doing | Roster dot, status line in the chat | Look |
| Unblock a bot | Card in the chat | Approve, Deny, Fix, Retry |
| Change anything else | Panel button, conversation header menu | Opens the window on the last tab used |
| Give a bot a service | Window, Connectors | Switch, or Set up |
| Wire a service for everyone | Settings, Connectors | Same sheet, no per-bot switch |
| Delete a bot | Window, Advanced | Type the name |

Keyboard: Esc closes the window. Cmd/Ctrl+, keeps opening global
Settings.

## Changes required

Daemon:

- `hexbot/connectors.py`: the catalog and the mapping onto Hermes
  config.
- RPC: `connectors.list` (catalog with daemon state and this bot's
  state), `connectors.setup`, `connectors.test`, `connectors.clear`,
  `connectors.set_for_bot`; `skills.list`, `skills.search`,
  `skills.install`; `bots.update` accepts `notify`, `approval_mode`,
  `workdir`, `daily_budget`. Status fields on `bots.list` and
  `bots.get`.
- `tools` on the bot record grows from five keys to the Tools page's
  list, still mapped through `TOOL_TOOLSETS`.

Client:

- `apps/web/src/app/panel/`: shrink to the Level 1 contents.
- `apps/web/src/routes/b.$bot.settings.$tab.tsx` plus
  `apps/web/src/app/bot-settings/`: the window, reusing the Settings
  dialog layout and the existing Memory, Model, Sections, and Dreaming
  components.
- `apps/web/src/app/settings/`: a Connectors tab.
- Roster: a red dot for `stopped` beside the existing green and amber.
- Conversation: the Stopped card, rendered from a `turn.failed` or
  connector error the same way approval cards are.

Docs: `docs/ui-design.md` (right panel section), `DESIGN.md`
(approvals and tools), the site docs page for bots.

## Phases

1. Window and panel split, the Stopped card in the chat, notify
   switch. No new capabilities yet; existing tabs move.
2. Connectors: catalog, sheet, daemon-scope credentials, the Search,
   Images and voice, Notes and work, and Social groups.
3. Channels and MCP servers (bot-scoped credentials, server lifecycle).
4. Skills hub search and install; per-bot approvals and budget.

## Open questions

- Should a room have the same window (members, main bot, limits)? The
  layout carries over; the tabs differ.
- Whether the daemon-scope Connectors tab in global Settings is needed
  at all in phase 2, or whether setting up from any bot is enough.
- Auto-enabling: when a daemon-scoped connector is set up from one bot,
  should it be on for new bots by default? Proposed: on for bots
  created afterwards, off for existing ones.
