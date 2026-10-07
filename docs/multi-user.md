# Multi-user

Milestone 5. One shared daemon per household; the admin runs it and owns
the provider keys. Owner ids exist on every row from milestone 1.

## Model

- `users(id, display_name, role admin|member, created_at, disabled_at)`;
  the first user is created at onboarding as admin with id `local`.
- Devices, bots, sections, rooms and dreams carry `owner_id`. About you is
  a file per user (`users/<owner_id>/user.md`), and each user's bots see
  only their owner's.
- `bots.shareable` lets other members add that bot to their rooms. A shared
  bot in someone else's room keeps its owner's memory and skills but reads
  no About you at all, neither its owner's nor the room owner's; its memory
  tool refuses notes and returns no memory text from writes there. Its
  memory is in its own prompt, so what the room must not see is the bot's
  daily notes, every About you, and the other sections' folders under
  `runtime/sessions` (their history quotes both, and their attachments are
  the owner's). Outside Bypass the bot's file tools refuse those paths
  (`privatePath`, with the whole `memories` folder for simplicity) and keep
  the guest's own section folder readable; so does the daemon's file bridge
  for its Python code (`hermes_tools.read_file`, `write_file`, `patch`),
  which also judges the file it opened by identity (device and inode,
  `PrivateFiles`), so a macOS firmlink alias such as `/System/Volumes/Data`,
  a hard link, or a link swapped in after the path check is refused too. The
  sandbox for its shell commands, the user's own `!` commands and its Python
  code hides the same files there (macOS by pattern and subpath; bubblewrap
  masks the whole `users` folder, every bot's `memories` folder and
  `runtime/sessions`, creating them first so a file written later lands
  under a mask, and binds the guest's own section back with its attachments
  folder writable; a code worker restarts when a new bot's folder needs a
  mask). Full access is not available in that session: a `full_access`
  request is refused with a short message before any approval card, since
  an unsandboxed command could reach a service broker on the host. Without
  an OS sandbox (Linux without bubblewrap) the guest's commands and code are
  refused rather than offered to the room owner for approval. Three gaps
  remain: the sandbox follows paths, so a hard link to one of these files
  made elsewhere is readable by a command (not by the bridge), which adds
  nothing an owner session could not already copy; the bot's
  `profiles/<bot>/artifacts` folder is shared by all of its sections, so
  code output and visuals the owner's sections put there are readable by a
  guest; and the bridge's `write_file` and `patch` resolve the path again
  when they write, so a link swapped in between the identity check and the
  write can place the written file elsewhere (an integrity limit; nothing
  private is read). The room section and its usage are attributed to the inviter. The
  room cannot loosen the bot's approval mode below what its owner configured.
- Only the admin can choose Bypass. Bypass runs tools with no sandbox and no
  credential checks, so a bot in that mode can read the admin's provider
  keys and every other file under the Hexbot home. The daemon refuses `off`
  for a member's bot or room ("Only the admin can choose Bypass.") and runs
  a member's bot in Auto if Bypass was stored before. Bypass also needs the
  section owner and the room owner to be the admin, so the admin's shared
  bot runs in Auto in a member's room. The app hides the option from members.
- Rooms may have several human members; `room_members.member_kind = human`
  rows point at users. Humans-only rooms are allowed; bots can be added
  later and see the transcript from the start. Members see the room in
  their list, read and post; only the owner changes or deletes it, and the
  room's bots run on the owner's budget.

## Auth

- Pairing codes carry the inviting user: the admin creates an invite
  (`hexbot.users.invite {display_name, role}`) which yields a pairing code
  bound to the new user id. Redeeming it creates the user's first device.
  The auth provider sets `Session.user_id = "device:<id>"` and the device
  row's `owner_id`; every RPC handler reads the caller's user through the
  connection identity and filters by it.
- Admin-only methods: providers, network, limits, users, usage of all
  users. Members manage only their own bots, sections, rooms and devices.
- Ownership is enforced by the daemon's RPC handlers and tools, not by the
  operating system. Every bot runs as the daemon's OS user, so a member's bot
  with the terminal or file toolset can read any user's About you, memory,
  soul, and section history under the Hexbot home; in the bot's own sessions
  the sandbox hides credential files only. Invite people you trust with the
  data on that daemon.

## Budgets and usage

- `users.limits_json` holds per-user daily token budgets set by the admin.
- Usage aggregation reads each bot profile's `session_model_usage` and
  attributes it by section owner or room inviter.
- `hexbot.usage.summary {user?, since}` for the admin's usage view.

## Client

- Sidebar footer shows the current user; the roster shows only owned and
  shared bots; rooms list members with avatars for humans.
- Settings gains a Users tab (admin): invite, rename, disable, budgets.

## Tests

Ownership filtering on every list method, invite and redeem flow, shared
bot in another user's room, admin-only method rejection with code 4301,
usage attribution by inviter.
