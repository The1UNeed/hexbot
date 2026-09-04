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
- Bot faces: every bot has a face, a shape and a colour with two eyes
  (`lib/avatar-builder.ts`). Uploaded images replace it; otherwise the face
  is derived from the bot's name. Faces wiggle on hover, blink at rest, and
  bob while the bot is working.
- Shadows only on floating layers (menus, dialogs): a hairline border plus
  one soft shadow. Nothing in-panel.
- Motion: 120ms ease-out for hover and open, 200ms for panel slide. Respect
  prefers-reduced-motion.

## Layout

Three columns, resizable, min widths 240 / 480 / 300.

### Left: roster

- Header: a window-drag strip (padded for the macOS traffic lights), a "+"
  menu (New bot, New section, New room) and a search pill. No app name.
- List: bots and rooms in one list, ordered by last activity. Each row:
  face (40px), name, last message preview, relative time, unread dot, and a
  green dot on the face while the bot is working. The selected bot's row is
  filled.
- Under each row: the one or two most recent sections as indented rows
  (title, time). A "more" affordance expands to the full list. Sections with
  no activity in 14 days are hidden behind "more".
- Bottom: Activity, an "Archived" collapsed group (only when there is
  something archived), then the current user with a connection dot on their
  avatar and a settings gear.
- Selection: one section is active. Selecting a bot row opens its most
  recent section.

### Centre: conversation

- Header: a 44px strip with a small face and the bot name, the section
  title beside it in muted text (click to rename), the model as a muted
  pill with a menu, section actions (rename, archive, delete), and a toggle
  for the right panel.
- Transcript: bot messages left-aligned and human messages right-aligned,
  both in grey bubbles (no avatars in a direct message; rooms show a small
  face and name). Copy and retry icons appear beside a bubble on hover.
  Markdown body with code blocks (copy button), tables, images. Time
  separators ("Today 9:13 PM") between days and after 20 quiet minutes.
  While a reply is pending the bot's face bobs beside "<name> is working".
  "Waiting on you" banner when a bot has asked the human something.
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

- A floating pill: a round "+" attach button on the left, the field, and a
  round send arrow on the right that becomes a stop square while streaming.
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

- A "Settings" page: a large face (click it for a Bot / Upload picker with
  the shape and colour grids), then labelled Name, Label and Description
  fields saved on blur, a Shareable switch card, and a list of sub-pages
  each opened with a back chevron in the header: Persona (editable persona
  text, saved on blur), Model (provider and model picker, live list with a
  curated group pinned on top), Memory (core memory sections editor, this
  bot's notes, and dreaming), Tools (switches), Skills, Sections (all
  sections with archive and delete), Computer. A red "Delete bot" action at
  the bottom of the root page.
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
