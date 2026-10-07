# Hexbot client UI design

Milestone 1 scope. Grok Bot's layout and interactions as patterns, Hexbot's
own visual identity. Read `CLAUDE.md` for the words.

## Principles

1. Flat, not boxed. Structure comes from whitespace and single hairlines,
   never nested rounded cards.
2. One primitive per concern: one Button, one Input, one Menu, one Dialog,
   one Avatar, one Chip. Variants via CVA, never one-off styles.
3. Tokens over literals. Every colour, radius and shadow is a CSS variable in
   `src/styles/tokens.css`. No raw hex in components.
4. A running turn is the normal state. Every transcript element renders
   correctly mid-turn: tool calls, approvals, attachments. A bot's words
   appear one finished message at a time, never mid-sentence.
5. Keyboard first: Enter sends, Shift+Enter newline, Esc stops or closes,
   Cmd/Ctrl+N new section, Cmd/Ctrl+K quick switcher (milestone 3).

## Tokens

- Font: system UI stack (SF Pro on macOS, Inter or Cantarell on Linux),
  14px base, 13px secondary, 12px meta, 20px title. Monospace for code:
  SF Mono, JetBrains Mono, monospace.
- Radii: 8px controls, 12px panels and cards, 18px message bubbles, full
  pills for the composer, chips and round icon buttons.
- Neutral first: the chrome is greys; colour comes from bot faces. Primary
  buttons are foreground-on-background (white on dark, black on light). The
  accent is reserved for unread dots and links.
- Light: bg #FFFFFF, surface #F5F5F5, surface-2 #EBEBEB, surface-3 #DEDEDE,
  text #141414, text-muted #767676, border #E3E3E3, accent #4F46E5,
  danger #D92D20, success #16A34A, warning #B54708.
- Dark: bg #0E0E0E, surface #171717, surface-2 #262626, surface-3 #343434,
  text #F4F4F4, text-muted #8E8E8E, border #2A2A2A, accent #8B85FF,
  danger #F4645B, success #34C759, warning #F7B24A.
- Chart series, for bot visuals only: light #4F46E5, #0D9488, #D97706,
  #DB2777, #2F7CF6, #65A30D; dark #8B85FF, #2DD4BF, #FBBF24, #F472B6,
  #4C9AFF, #A3E635. The first is the accent; the rest step apart in hue.
- Bot faces: every bot has a face, a shape and a colour with two eyes
  (`lib/avatar-builder.ts`). Uploaded images replace it; otherwise the face
  is derived from the bot's name. Faces wiggle on hover and blink at rest.
  Click any face, or the Hexbot mark, and it plays a random act for a few
  seconds: typing with its two round hands, juggling, blowing a horn
  (`components/ui/hexbot-act.tsx`, 21 acts). The install screen gives each
  stage its own act. In a chat the face never changes size or plays acts on
  its own: a working bot's face only bobs (`hex-think`).
- Shadows only on floating layers (menus, dialogs, the glass chrome) and the
  cards that sit on the canvas: a hairline plus one soft shadow.
- Liquid glass (`hex-glass`, `hex-glass-strong` in `tokens.css`) is for
  floating chrome only: the name pill and round buttons above the chat, the
  composer, the waiting pill, the side panel, dialogs and menus. As on iOS,
  a clear fill blurs and saturates what scrolls under it, and a hairline
  specular rim catches light on the top-left edge and, fainter, on the
  bottom-right. Rim, edge glow and shadow are one `box-shadow`, so glass
  costs one backdrop blur and nothing else; no SVG filters. Pressing glass
  (`hex-glass-press`) swells it on a spring (`--hex-ease-glass`, 1.1, or
  1.04 for wide pills via `--hex-press-scale`) and lights it from within;
  letting go springs it back. Reduce transparency turns it solid. Content
  (bubbles, cards, rows) is never glass.
- Motion, one short scale in `tokens.css`: 120 ms (`fast`) for hover, press
  and menus; 180 ms (`rise`) for a label or popover arriving, a 4 px lift
  and a fade, never a scale; 320 ms (`enter`, `ease-spring`) for a chat
  message arriving whole, like a text: it springs up from its tail corner
  (bottom left for a bot, bottom right for you), the one place a scale is
  used. The live status appears and leaves with no motion; 240 ms (`panel`) for the side panel and for anything
  that unfolds or folds in the column; 320 ms (`enter`) for a whole screen.
  `ease-out` settles, `ease-in-out` is for things leaving, `ease-spring` is
  for small controls that snap into place (the switch knob). Only what
  arrives while the chat is open animates: history is drawn still. The one
  continuous motion is a working bot's face. Respect prefers-reduced-motion.
- Focus: the accent ring, 2 px outside the shape (`hex-focus`), on every
  rounded control, including the glass pills.

## Layout

Three columns, resizable, min widths 240 / 480 / 300. The window is a grey
canvas: the roster sits on it directly, and the conversation and the side
panel are rounded cards (22 px) inset 8 px from its edges, with the resize
handles in the gutters. Under 700 px the conversation fills the window and
the roster slides in as a drawer.

### Left: roster

- Header: a window-drag strip (padded for the macOS traffic lights) with one
  row: the search pill and a round glass "+" menu (New bot, New section, New
  room). No app name. The selected row is a white card on the canvas.
- List: bots and rooms in one list, ordered by last activity. A bot row is
  its face (40px), name, optional label, and a status dot on the face (see
  "Status colours"). No times, no message preview: a bot has many
  sections, so one message says little. A room row is the room's cluster
  (one face, or up to four in a 2x2 grid), name, latest message, and the
  same status dot. Both rows end in a status tag while it applies: a purple
  "Waiting" (question-mark icon) or a blue "Working" (wrench). A section
  row shows only "Waiting"; "Working" there would be noise.
- Under each bot: its two most recent touched sections from the last 14
  days, newest first, plus the open one. A section row is one line: its
  title and the status tag. The title is the first message until the bot
  names the section with its tool; it changes the moment you send, and a
  rename fades in where the old title was. A section is touched once the user
  has sent something in it, or typed a draft in its composer; drafts are
  kept per section in the browser and the row shows a pencil until the text
  is sent. Untouched sections and older ones stay behind "More", which lists
  everything with untouched sections last.
  A bot with nothing to list is just its row; there is no fold toggle.
- Bottom: the current user with a connection dot on their avatar and a
  settings gear. Archived sections are not listed here; they live in
  Settings, Archive.
- Selection: one section is active, or the bot row is filled when its open
  section is not listed. Clicking a bot row starts fresh: it opens the bot's
  newest untouched section, or creates one. The header "+" menu also creates
  a section for the open bot.

### Centre: conversation

- Header: nothing but floating glass over the transcript, which scrolls
  under it. In the centre, a pill with the bot's face (status dot on it,
  bobbing while it works), its name, and the section title in muted text;
  clicking it opens or closes the side panel. Top right, round glass buttons for section actions (Rename,
  Archive, Delete) and, while the panel is closed, the panel toggle. The
  model is chosen in Bot settings, Model, not in the chat.
- Transcript: a centred column capped at 52rem. Bot messages left-aligned
  in soft grey bubbles, human messages right-aligned in inverse bubbles
  (black on light, white on dark). A bot's own chat draws no faces in the
  column (the pill says whose chat it is); a room draws the bot's face and
  name beside its bubbles. Every bubble and card is fully rounded (20 px,
  a pill when it is one line) on a shared left edge; bubbles and cards from
  the same side in a row stack 4 px apart, and a new speaker starts 12 px
  lower. Each message a bot finishes is its own bubble, so a turn that
  says "I'll run both" and then reports back is two bubbles, live and after
  a reload. Copy and retry icons appear beside the last bubble on hover.
  Markdown body with code blocks (a fenced block is a block even without a
  language; its copy button shows on hover), tables, images. Time
  separators ("Today 9:13 PM") between days and after 20 quiet minutes.
- Live status: from the moment a turn starts until the whole turn is done,
  a line sits at its foot, under the messages the bot has finished: the
  bot's bobbing face and muted words, with no bubble behind them. It says
  what the bot is doing in plain words ("General is thinking", "General is
  writing", "General is working", "General is searching the web", "General
  is running a command", "Connecting to GitHub" for a connector's tool, or
  the provider's wait notice), never the command, the query or the time;
  the side panel says the same. The face keeps bobbing while a tool runs.
  No spinner, no ring, no shimmer. Each new label crossfades in. What the
  bot is still writing stays hidden ("General is writing"); the message
  appears whole when it is done and springs in. When the turn ends the line
  is gone at once, the closing message springs in, and the summary line
  fades in at the foot of the turn, where the status was.
- "Waiting on you" is a purple glass pill pinned under the header pill
  while a bot has asked the human something (in a room it names the bot).
  Nothing is written into the transcript for it. A red banner names the bot
  when a room turn failed.
- Work card: thinking traces and steps are hidden until asked for. Click
  the live status and it opens under it, set off by a thin rule on the left
  and no background, with the
  reasoning trace as it streams and each step as a one-line row; a row
  opens to its arguments and output in monospace only when clicked. The
  card and a row's detail unfold into the column rather than popping. Once
  opened the card stays open until the turn ends; "Open in Computer" shows
  the same steps in the side panel. When the turn ends the work collapses
  into one small muted line at the foot of the turn ("Thought for 12s",
  "Worked for 3s") that opens into the same card. Work that finished in under two
  seconds leaves no line.
  Housekeeping tools (memory, tasks, section search, skills, renaming the
  section) never appear once finished. The Computer tab in the panel still
  lists every call.
- Approvals: an inline card with the command or action in monospace, the
  reason, and three buttons: Approve, Allow in this section, Deny. Requests
  raised by the daemon (code runs, browser scripts, cron) show Approve and
  Deny only. The card stays in the transcript after the decision, marked
  with the outcome.
- While a turn runs the composer's send button becomes Stop. Text does not
  type itself out; each message appears whole and springs in. In a room the
  bot's words arrive as its room message when its turn ends.
- Attachments: images render inline with a lightbox; files render as chips
  with name, size, and type icon.
- Questions: when a bot asks through the clarify tool, a card with the
  question, the choices as rows A, B, C… (the first marked Recommended)
  and a field for the user's own answer. One click answers a single-choice
  question; multi-select and typed answers confirm with Done. An answered
  card collapses to the chosen line with a check. The card survives a
  reload (the daemon replays the pending question when the section opens).
- Errors: a Stopped card with the message and a retry action; one card per
  failure, even when the gateway and the daemon both report it.

### Status colours

One colour per state, used everywhere a bot or room shows one: blue while
it works (the dot pulses), purple (the accent) when it needs you, red when
it stopped, green when it finished and you have not opened it yet on any device. The dot
sits on the face in the roster, at the start of the section row it is about,
on the face in the header pill, and on the room cluster. A section
row with an unsent draft and no status shows a draft icon in the same slot.
The composer pill takes the same colour; a stopped bot puts its error in a
one-line notice above it. Waiting is the pill under the header, not a
notice. Working and idle draw the plain pill.

### Composer

- A floating glass pill over the foot of the transcript, which scrolls
  under it: a round "+" attach button on the left, the field, and a round
  send arrow on the right that becomes a stop square while streaming.
- 46 px tall for one line, with 30 px round buttons set 8 px in so they
  stay concentric with the pill's corners as the field grows. Multiline
  textarea growing to 8 lines, then scrolling. Placeholder
  "Message {bot name}".
- Left: attach button (file picker; drag and drop anywhere over the
  transcript; paste images and text files). Attachments preview as chips
  above the textarea with remove buttons.
- Right: dictation button (Hexbot voice), send button (accent) that turns
  into Stop while streaming.
- @-mention: typing "@" opens a popover listing the section's bot and, in
  rooms, all members (milestone 3).

### Right: side panel

- A glass card opened from the name pill above the chat. At the top, the
  bot's large face (click it for the Bot / Upload picker), its name and
  label as bare fields saved on blur ("Add a label" when empty), and while
  the bot works, a blue status chip saying what it is doing in plain words
  that opens Computer.
- Three tabs in a segmented control:
  - Details: the description, a card with Model (opens Bot settings, Model)
    and the "Notify me" switch (native notifications when this bot stops or
    needs you), a card of doors into Bot settings (Soul, Memory, Tools,
    Connectors, Skills), and "Bot settings" for the tab last used.
  - Library: images (a three-column grid) and files shared in the section,
    newest first.
  - Computer: every tool call in the section, housekeeping included, newest
    first, each with its glyph, time and result mark, closed until clicked
    open to its arguments and output. A plain-words line on top says what
    the bot is doing while a tool runs, and the tab shows a still blue dot.
- Opening and closing is one 240 ms move: the panel's column widens or
  narrows while the chat column follows, and the card slides in from the
  right edge. The panel remembers open or closed, and its tab, per window.
  Under 1100 px it floats over the chat and slides in from the right.

### Settings windows

Settings, Bot settings and Room settings share one shell
(`components/ui/settings-shell.tsx`): a glass window (`hex-glass-strong`,
24 px radius) over the dimmed, blurred app, with a round glass close button
floating in the top right corner and no title bar. Tabs run down the left
(220 px, transparent over the glass) as icon-and-label rows under tiny muted
group labels; the active tab is a soft filled pill. Under 640 px the tabs
become one scrolling pill row on top. Room settings has no tabs and is a
narrower, single-column window.

A page is a 20 px title, one muted line, then grouped lists in the iOS and
macOS style: a small muted label, one white card (a faint white film in
dark) with hairline dividers, and rows of 52 px or more that hold a title, an
optional second line, and one control on the right (a switch, a select, a
small button, or a value). Choices such as approval modes are rows with a
check; text fields inside a card are bare, with their label on the left.
Longer texts (memory, the soul) are one card-shaped editor. Nothing is
nested inside a card and no row carries more than one line of explanation.

### Bot settings window

- Route `/b/$bot/settings/$tab`, rendered in the shared shell over the
  three columns; the bot's face and name sit at the top of the tab list.
  Closing returns to the section that was open. `?connector=<id>` opens
  that connector's set-up sheet, which is how a "Fix Notion" action in the
  chat lands here.
- Tabs in three groups: Profile, Soul, Model; Abilities (Memory, Tools,
  Connectors, Skills); Manage (Approvals, Sections, Advanced).
- Tabs: Profile (face, name, label, description, Shareable), Soul
  (full-height editor, template menu with a confirm, word count), Model
  (provider and model, curated group pinned on top, context and price
  when known), Memory (this bot's memory and dreaming; About you is
  shared and links to Settings, Memory), Tools (switches grouped as
  Computer, Senses, Working with others, plus the working directory),
  Connectors (below), Skills (installed skills with switches, grouped by
  category), Approvals (Inherit, Manual, Auto, and Bypass for the admin),
  Sections (open and
  archived, with archive and delete), Advanced (Delete bot with the
  type-the-name confirmation).
- Connectors: a search pill, filter chips (All, On for this bot, Needs
  setup), and rows grouped as Search and browsing, Images and voice,
  Notes and work, Social and home, MCP servers. Each row: a 28 px icon
  (Simple Icons brand glyph in white on the brand colour, or a neutral
  glyph for rows that front several providers), name, state in words,
  one-line description, and one control: "Set up" when the daemon has no
  credentials, a switch when it does, "Fix" in the primary style when the
  last use failed. Clicking the row expands it to the saved fields, the
  last error, Edit, Remove values, and for MCP servers Remove server. An
  "Add MCP server" row takes a name and a command or URL.
- The set-up sheet is a dialog over the window: the connector's fields
  (secrets masked, "Show advanced" for the rest), a provider select when
  the connector has several backends, a help line with a "Where to get
  it" link, a "Turn on for <bot>" switch defaulted on, an advanced "Use a
  different value for this bot only" switch, Cancel and "Connect and
  test". The daemon saves, tests, and the sheet closes only on success;
  a failed test keeps it open with the message under the field.
- Fields save on blur and switches on change. Errors show inline. No
  Save button.

## Screens outside the three columns

### First launch

1. Choice: "Where should Hexbot run?" with "On this computer" or "On another
   device".
2. Connect: address field (host:port or URL) and pairing code field, or
   paste a hexbot:// link. Shows daemon name after a successful probe.
3. Run locally: runtime install progress (uv, Python, Git, ripgrep,
   dependencies) with a log disclosure; then the service question ("Keep
   Hexbot running in the background when the app is closed", default on).
4. About you: name, what you do, and how bots should talk to you. Saved as
   the user's About you, so every bot they own reads it from the first
   message. Asked once per user, at the first startup where it is empty,
   also for users who already have bots. Skip saves an empty text.
5. Providers: add at least one provider key. A notice reads: "Hexbot does
   not include any model credits. Usage is billed by your providers."
6. Defaults and tools: the default model, then web search and the other
   tools that need their own account. Both can be skipped.
7. First bot: name, avatar, model. Persona optional. Creates the bot and its
   first section, lands in the chat.

### Settings (the shared shell, global tabs)

Tabs in four groups: Models (Providers, Usage), Devices (Network, Hex
Connect, Users), You (Memory, Archive, Approvals, Appearance), App (Updates,
About).

- Providers: a search pill, then "Connected" and "More providers" cards,
  one row per provider with its state and one control ("Add key", "Sign
  in", or a Connected chip). A row expands to the key field with Save and
  Test, or the sign-in flow, and Remove key. A Defaults card holds the
  default and fallback model. The billing notice is the page's one line.
- Network: "Allow other devices on this network" switch, the addresses
  while it is on, a Paired devices card with Revoke and "Create link", and
  the pairing card (code, QR, link, Copy) once a link exists.
- Archive: every archived section, newest first, grouped This week, Last
  week, then by month. A search pill matches titles, first messages, and bot
  names; a chip per bot narrows the list; on wide windows a rail on the right
  jumps between groups. Each row shows the bot's face, title, bot, message
  count, first message, and the archive date; hovering shows Open and Restore.
- Approvals: "Choose when Hexbot asks before a bot acts. Bots and rooms can
  override it." Modes Manual, Auto, and Bypass (admin only), one row each;
  a notice when the daemon has no OS sandbox.
- Appearance: theme System, Light, Dark.
- Updates: current version, channel, check now.
- About: version, license, links.

### Pairing on the daemon side

- `hexbot pair` prints the code, the addresses, and a QR in the terminal.
- The desktop app shows the same in Settings > Network.

## States

- Connecting, connected, reconnecting (with attempt count), unauthorised
  (device token revoked: return to the connect screen with a message),
  daemon offline (full-panel message with retry).
- Empty roster: a single centred call to action to create a bot.
- New bot: a dialog with a face and a name, nothing else (provider and
  model come from the defaults; "Change" reveals them). The bot then asks
  the rest itself: the client calls `hexbot.bots.introduce` once it has
  opened the section, and the daemon's hidden first prompt
  (`backend/hexbot-core/src/catalog.rs`) makes the bot greet the user, ask up to three
  clarify questions shaped by its name, and write the answers into its
  soul and memory. The room's "Room settings" (the info button in the
  header, route `/r/$room/settings`) holds the name, the members with
  Make main and a two-step Remove, Add bot, approval mode, limits, and
  Delete room. Removing the last bot deletes the room, never the bot.
- Empty section: the bot's avatar, name, and title, and three suggested
  prompts derived from its description, drawn as plain grey pills (content,
  not glass).

## Accessibility

- All controls reachable by keyboard with visible focus rings using the
  accent colour.
- Live region announces new bot messages when the window is not focused.
- Colour contrast at least 4.5:1 for text in both themes.
