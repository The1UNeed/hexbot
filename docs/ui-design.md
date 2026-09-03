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
4. Streaming is the normal state. Every transcript element renders correctly
   while partial: text, tool calls, approvals, attachments.
5. Keyboard first: Enter sends, Shift+Enter newline, Esc stops or closes,
   Cmd/Ctrl+N new section, Cmd/Ctrl+K quick switcher (milestone 3).

## Tokens

- Font: system UI stack (SF Pro on macOS, Inter or Cantarell on Linux),
  14px base, 13px secondary, 12px meta, 20px title. Monospace for code:
  SF Mono, JetBrains Mono, monospace.
- Radii: 6px controls, 10px panels and cards, 16px message bubbles.
- Light: bg #FAFAF9, surface #FFFFFF, surface-2 #F3F3F1, text #17171A,
  text-muted #6B6B72, border #E6E6E2, accent #4F46E5, accent-fg #FFFFFF,
  danger #D92D20, success #12805C, warning #B54708.
- Dark: bg #121214, surface #1A1A1E, surface-2 #232328, text #F2F2F4,
  text-muted #9A9AA3, border #2C2C33, accent #8B85FF, accent-fg #121214,
  danger #F97066, success #3CCB7F, warning #F7B24A.
- Shadows only on floating layers (menus, dialogs): a hairline border plus
  one soft shadow. Nothing in-panel.
- Motion: 120ms ease-out for hover and open, 200ms for panel slide. Respect
  prefers-reduced-motion.

## Layout

Three columns, resizable, min widths 240 / 480 / 300.

### Left: roster

- Header: app name, search field, "New" menu (New bot, New section, New room
  from milestone 3).
- List: bots and rooms in one list, ordered by last activity. Each row:
  avatar (uploaded image or initials on a per-bot hue), name, model chip
  (small, muted), last message preview, relative time, unread dot.
- Under each row: the one or two most recent sections as indented rows
  (title, time). A "more" affordance expands to the full list. Sections with
  no activity in 14 days are hidden behind "more".
- Bottom: "Archived" collapsed group, then a footer with connection state
  (daemon name or address, green/amber/red dot) and a settings gear.
- Selection: one section is active. Selecting a bot row opens its most
  recent section.

### Centre: conversation

- Header: bot avatar and name, section title (editable inline), model chip
  with a menu to change the section's model, section actions (rename,
  archive, delete, dream now from milestone 4), and a toggle for the right
  panel.
- Transcript: virtualised list. Human messages right-aligned in an accent
  tinted bubble. Bot messages left-aligned, no bubble, avatar and name on
  the first message of a run, markdown body with code blocks (copy button),
  tables, images. Day separators. "Waiting on you" banner when a bot has
  asked the human something (milestone 3).
- Tool activity: an inline collapsed row per tool call with icon, tool name,
  a one-line summary, and a spinner while running. Expand shows arguments
  and output in monospace. Consecutive tool calls group into one block.
- Approvals: an inline card with the command or action in monospace, the
  reason, and three buttons: Approve, Deny, Always allow. The card stays in
  the transcript after the decision, marked with the outcome.
- Streaming: text appears as it arrives with a subtle caret; the composer's
  send button becomes Stop.
- Attachments: images render inline with a lightbox; files render as chips
  with name, size, and type icon.
- Errors: a muted inline row with the message and a retry action.

### Composer

- Multiline textarea growing to 8 lines, then scrolling. Placeholder
  "Message {bot name}".
- Left: attach button (file picker; drag and drop anywhere over the
  transcript; paste images and text files). Attachments preview as chips
  above the textarea with remove buttons.
- Right: dictation button (Hermes voice), send button (accent) that turns
  into Stop while streaming.
- @-mention: typing "@" opens a popover listing the section's bot and, in
  rooms, all members (milestone 3).

### Right: profile panel

- Bot: large avatar, name, title, description. Tabs: Persona (editable
  persona text, saved on blur), Model (provider and model picker, live list
  with a curated group pinned on top), Memory (core memory sections editor,
  and this bot's notes, read-only for now with an "edit" affordance),
  Skills (list of attached skills), Sections (all sections with archive and
  delete). Danger zone at the bottom: delete bot.
- The panel remembers open or closed per window.

## Screens outside the three columns

### First launch

1. Choice: "Connect to a Hexbot daemon" or "Run Hexbot on this machine".
2. Connect: address field (host:port or URL) and pairing code field, or
   paste a hexbot:// link. Shows daemon name after a successful probe.
3. Run locally: runtime install progress (uv, Python, Git, ripgrep,
   dependencies) with a log disclosure; then the service question ("Keep
   Hexbot running in the background when the app is closed", default on).
4. Providers: add at least one provider key. A notice reads: "Hexbot does
   not include any model credits. Usage is billed by your providers."
5. First bot: name, avatar, model. Persona optional. Creates the bot and its
   first section, lands in the chat.

### Settings (dialog with left tabs)

- Providers: list of configured providers with key status, add and remove,
  test button, the billing notice.
- Network: "Allow other devices on this network" toggle. When on: shows the
  address list, the current pairing code (rotates every 10 minutes or after
  use), a QR of the hexbot:// link, and the list of paired devices with
  last seen and a Revoke button.
- Approvals: mode Manual, Auto, Off; explanation of each; the small model
  used by Auto.
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
- Empty section: the bot's avatar, name, and title, and three suggested
  prompts derived from its description.

## Accessibility

- All controls reachable by keyboard with visible focus rings using the
  accent colour.
- Live region announces new bot messages when the window is not focused.
- Colour contrast at least 4.5:1 for text in both themes.
