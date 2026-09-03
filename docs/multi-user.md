# Multi-user

Milestone 5. One shared daemon per household; the admin runs it and owns
the provider keys. Owner ids exist on every row from milestone 1.

## Model

- `users(id, display_name, role admin|member, created_at, disabled_at)`;
  the first user is created at onboarding as admin with id `local`.
- Devices, bots, sections, rooms, memory rows and dreams carry `owner_id`.
  Core memory becomes per user (`core_memory.owner_id`), and each user's
  bots see only their owner's core memory.
- `bots.shareable` lets other members add that bot to their rooms. A shared
  bot in someone else's room keeps its owner's memory and skills; the room
  section and its usage are attributed to the inviter.
- Rooms may have several human members; `room_members.member_kind = human`
  rows point at users. Humans-only rooms are allowed; bots can be added
  later and see the transcript from the start.

## Auth

- Pairing codes carry the inviting user: the admin creates an invite
  (`hexbot.users.invite {display_name, role}`) which yields a pairing code
  bound to the new user id. Redeeming it creates the user's first device.
  The auth provider sets `Session.user_id = "device:<id>"` and the device
  row's `owner_id`; every RPC handler reads the caller's user through the
  connection identity and filters by it.
- Admin-only methods: providers, network, limits, users, usage of all
  users. Members manage only their own bots, sections, rooms and devices.

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
