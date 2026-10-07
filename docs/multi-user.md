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
  tool refuses notes and returns no memory text from writes there, and its
  file tools refuse its owner's memory and notes and every About you,
  outside Bypass. The room section and its usage are attributed to the
  inviter. The room cannot loosen the bot's approval mode below what its
  owner configured.
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
  soul, and section history under the Hexbot home; the sandbox hides credential
  files only. Invite people you trust with the data on that daemon.

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
