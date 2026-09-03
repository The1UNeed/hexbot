# Hermes Hosted Rooms — internals for Hexbot rooms

All paths relative to `/Users/alex/Desktop/Projects/Hexbot`. Line numbers are from files I read.

## 1. Lifecycle

**`groups.create {room_id, name, members}`** → `tui_gateway/methods_groups.py:505-529` → `HostedRoomService.create_room` (`tui_gateway/hosted_room_service.py:668-694`) → `discussion.validate_roster` → `hosted_rooms.create_room`.

Member object (`gateway/hosted_room_discussion.py:360-447`): exact fields `{member_id, profile, handle}` required, `{display_name, target}` optional. Any of `connection_id`/`targetProfile`/`route`/... (`_REMOTE_MEMBER_FIELDS`, l.58) is rejected. `target` is `{kind:"local", profile}` (profile must exist under `<root>/profiles/`) or `{kind:"peer", peer_id, installation_id, profile, capability_digest}` (`_validate_member_target`, l.292). Roster must be **2–6 members** (`MIN/MAX_DISCUSSION_MEMBERS`, l.29-30); handles unique and cannot be `all`/`everyone`; member_ids unique; targets unique.

There is **no owner/actor concept**. Authority is the gateway install id (`local_authority_gateway_id`, `gateway/hosted_rooms.py:278`), never client-supplied. Creation is idempotent; a differing name or roster → `RoomConflictError`. `create_room` writes no `room.created` event (`hosted_rooms.py:1414-1580`) — the log starts empty.

**`groups.send {room_id, event_id, payload}`** (`methods_groups.py:559-597`) accepts only `message.user` with payload exactly `{text, thread_id}` (`validate_user_payload`, discussion.py:272). Client `event_id` is rewritten to `user:<sha256>` (`hosted_rooms.py:316`). Actor is forced to `{kind:"user", id:"desktop"}` (`hosted_room_service.py:696-727`).

After the append, `send` calls `prepare_room` synchronously, then `runtime.wakeup()`.

**Who responds / scheduling.** `prepare_room` (`hosted_room_service.py:599-659`) reconciles terminal driver rows into log events, then calls `discussion.plan_next_task` for **at most one** task and `driver.admit_task`. `HostedRoomRuntime` (`tui_gateway/hosted_room_driver.py:124+`) is a supervisor thread that spawns one daemon thread per room, `max_concurrent_rooms=4` (l.163), each holding a SQLite room lease. `_execute_attempt` (l.881) takes a per-profile turn lock (flock, `tools/bot_relay.acquire_turn_lock`), resolves or creates the member session, and calls `prompt.submit` in-process via `HostedRoomServerRPC` (`tui_gateway/hosted_room_server_rpc.py`) with a non-forgeable `_hosted_task` proof (`tui_gateway/methods_prompt.py:339-352`).

**Reply publication.** On terminal, `discussion.plan_publication` (discussion.py:1292) emits `message.member` (unless the text is `(pass)` — `is_pass_text`, l.484) then a `turn.settled|failed|cancelled|deferred` event, appended by `_append_plan`. Turn loops until `plan_next_task` returns `settled`/`bounded`, which appends `room.activity`.

**Client notification: none.** No `groups.*` notification exists; `docs/upstream/ws-api.md:152-157` lists methods only. Driver-created sessions have no bound transport, so `write_json` (`tui_gateway/server.py:2567-2597`) drops their `approval.request`/stream events to stdio. **The client must poll `groups.log`/`groups.state`.**

`groups.log` returns `{events:[{room_id, seq, event_id, kind, actor, authority_epoch, payload, created_at}], cursor, latest_seq, has_more, authority:{gateway_id, epoch}}` (`hosted_rooms.py:2351-2446`), `limit` ≤ 500, page ≤ 2 MiB. `groups.state` returns `{room:{room_id,name,members,authority_gateway_id,authority_epoch,revision,latest_seq,created_at,updated_at,...}, driver_status:{running,working,blocked,counts,pending_actions,peer_routes}}`.

Event kinds and their actor kinds: `hosted_rooms.py:133-155`. Payload field sets: `discussion.py:73-111`.

## 2. Discussion policy

`plan_next_task` (discussion.py:1029-1180) runs on **every** `prepare_room` — after any user message, after every terminal turn, and on each idle poll. There is no separate "Discussion" mode: every room is a Discussion.

Selection: the oldest pending `message.user` per thread that is past the stop fence and not already `settled`/`bounded`. **Round 0** responders = `resolve_mentions(user_text, members)` with `default_all=True` — an @-handle match picks those members, `@all`/`@everyone` or **no recognised handle** picks *everyone* (discussion.py:494-516). **Rounds 1–2** responders = `_unaddressed_member_mentions` (l.517): only members a bot @-cited and who have not spoken since. Order rotates by round (`_rotate`, l.851). Members with an empty delta are skipped; a round with no member message ends the discussion (`silent_round`).

Caps: `MAX_DISCUSSION_MESSAGES = 10` per discussion, `MAX_DISCUSSION_ROUNDS = 3`, roster 2–6, `MAX_DISCUSSION_DELTA_LINES = 24`, `driver.MAX_PROMPT_BYTES = 128 KiB`. The caps are also **baked into validators**: `_TURN_ID_RE` (l.45) hard-codes `r[0-2]` and `p[0-5]`, and `_validate_turn_coordinates` (l.637) bounds `member_index ≤ 5`, `round_index ≤ 2`. So raising the caps means editing the regex and those bounds, not just the constants.

The "who responds" decision lives entirely in `plan_next_task`; it is **not** pluggable. `hosted_room_execution_policy.py` is unrelated — it is the *target-side* authority for cross-gateway RoomLink turns (toolsets, approval mode, max_iterations), bound only in `gateway/platforms/api_server_runs.py:821-827`. Local member turns never bind it.

A one-bot room is impossible today (roster min 2).

## 3. Membership

**No add/remove path exists.** `members_json` is written once by `create_room` and only rewritten by the legacy-adoption branch (`hosted_rooms.py:1505-1520`). `room.members_changed` and `room.created` are declared allowed system kinds (`hosted_rooms.py:150-152`) but nothing in the tree ever appends them (verified by grep). `groups.promote`/`demote` are *authority* failover, not membership.

Minimal Hexbot design that works with the existing engine:
- Append custom events to the log. `_validate_event` (discussion.py:546-627) falls through unknown kinds without error, so a Hexbot kind (or `room.members_changed` with a `system` actor) is inert to the policy. `hosted_rooms.append_event` requires the kind to be in `_EVENT_KINDS_BY_ACTOR` for that actor kind, so either reuse `room.members_changed` (actor `system`) or add one kind there.
- Keep the Hexbot membership table as the source of truth and stop using `discussion.plan_next_task`. **Warning:** `validate_room` re-validates the *current* roster against replayed events on every poll, and `_validate_member_message` (l.661) resolves `member_id` against it. Removing a member makes its historical `message.member` events unreplayable → `prepare_room` throws and the room wedges. So a departing bot must stay in `members_json` (flagged inactive in the Hexbot table) — which also gives you "a bot keeps its history when it leaves" for free.
- To run a turn for a newly added member with prior context: build a `DiscussionTaskPlan`-shaped payload `{target_member_id, target_profile, prompt, source_event_seq}` and call `driver.admit_task(db_path, TaskIdentity(room_id, task_id, thread_id, turn_id), payload=...)`, then `runtime.wakeup()`. Publication back into the log is `discussion.plan_publication` + `hosted_rooms.append_event`. A member with watermark 0 naturally gets the whole thread delta — bounded to the last 24 messages and 128 KiB by `_build_prompt` (l.883) and `MAX_THREAD_TRANSCRIPT_EVENTS = 24` in `gateway/hosted_room_policy_checkpoint.py:20`.

## 4. Member turns and memory

Session per (profile, room): title `Group: <room_id>` (`hosted_room_driver.py:1506`), `source="bot_room"`, created hidden with `room_plumbing: true, follow_profile_config: true, close_on_disconnect: false` (`hosted_room_server_rpc.py:68-80`). It is a **normal Hermes session in that profile's own state.db**, so SOUL.md, MEMORY.md, skills and the profile's *current* model apply; `room_plumbing` explicitly suppresses restoring the pinned model/provider (`tui_gateway/server.py:4165-4172`, `5555-5578`). The `bot_room` toolset itself is empty (`toolsets.py:243-247`).

The transcript is **not** conversation history — it is a prompt digest. Each turn submits a synthesised prompt (discussion.py:883-935): a header naming the room, the bot's handle and peers, then up to 24 delta lines `@handle: text` / `User (user): text` since that member's watermark, plus fixed rules (reply once, `(pass)` for nothing to add, mention a teammate to pull them in, never leak private conversations). The session itself persists across turns and rooms-days, so the bot also carries its own prior turns in its session context.

## 5. Approvals, stop, limits

- `groups.approve` (`methods_groups.py:697-720` → service l.802-863) resolves an approval identified by `{room_id, member_id, task_id, execution_generation, request_id, choice∈{once,deny}}`. Local approvals go through `approval.respond`; peer ones through the RoomLink client.
- Discovery is **polled, not pushed**: the driver's `_wait_for_terminal` calls `transport.info()`, which reads `_pending_approval_request_payload` (`hosted_room_server_rpc.py:152-177`) and reports via `_report_pending_action` (`hosted_room_driver.py:588`) into `service._pending_actions`, surfaced in `groups.state → driver_status.pending_actions` as `{kind:"approval", task_id, execution_generation, session_id, request_id, approval}`. `approval.request` events are emitted but land on stdio.
- `groups.stop` appends `room.stop_requested` (a fence: user events at or below that seq are dead) and cancels queued/running/deferred tasks. `groups.retry` re-runs one `indeterminate` or `deferred` task.
- **No per-room turn caps, token budgets, or rate limits exist.** The only bounds are the Discussion caps, `MAX_EVENTS_PER_ROOM = 50_000`, `MAX_ROOM_EVENT_BYTES = 256 MiB`, `MAX_ACTIVE_ROOMS = 256`, and `HERMES_AGENT_TIMEOUT + 30 s` per turn.
- **No "tag a human" event kind.** `@user` in a reply resolves to nothing (`resolve_mentions` only matches member handles); Hexbot must detect it in `message.member.text` and hold the room itself. Note the trap: in round 0, a user message that @-mentions only a non-member handle falls back to **everyone responding**.

## 6. Bot-to-bot DMs

`tools/bot_mode_dm.py` injects a `message_agent` tool (not registered globally) only into a bot's canonical `Bot Chat` session, gated again at dispatch (l.253-270). Local delivery is **a subprocess, not gateway multiplexing**: `hermes -p <profile> chat --in ~ -c "Bot Chat" --create-if-missing -Q` (`tools/bot_relay.py:564-579`), spawned via `terminal_tool(background=True, notify_on_complete=True)`, serialised by the per-profile flock. It is fire-and-forget; the reply reaches the sender as a background-completion notification on its next turn.

Cross-connection targets need the desktop as relay: `bot_relay.outbox.drain` → `bot_relay.deliver` on the target gateway → `bot_relay.reply` back on the sender's. Roster rows are `{profile, handle, connection_id, connection_label, title, description, online?}` (`bot_relay.py:111-148`), stored in `<root>/bot_relay/roster.json`.

Observability: no events, no dedicated tables. The DM is a normal turn in the target profile's `Bot Chat` session, readable with `session.list`/`session.history` for that profile. Envelopes are files under `<root>/bot_relay/`.

## 7. Gaps, in priority order

1. **Roster caps.** 2–6 members, plus `_TURN_ID_RE` `r[0-2]`/`p[0-5]` and `_validate_turn_coordinates` bounds. Core edit, already noted as `CORE_EDITS.md` #1 — but that entry names three files and misses that the regex and coordinate bounds must move together.
2. **Membership mutation.** Nothing exists. Hexbot table + a `room.members_changed` writer; never delete a member from `members_json`.
3. **Client push.** No room notifications. Either poll `groups.log` from the desktop, or add a Hexbot-side broadcast when appending (cheap, additive: `_broadcast_global_event`).
4. **Main bot / routing.** `default_all=True` fan-out is the opposite of "main bot answers when nobody is mentioned". Replacing `plan_next_task`'s responder selection is the core edit, or Hexbot drives `driver.admit_task` itself and stops calling `plan_next_task`.
5. **Turn caps and token budgets.** Nothing exists; entirely Hexbot-side, enforced before `admit_task`.
6. **Tag-a-human waiting state.** Detect `@user` in `message.member`, append a Hexbot event, suppress further turns.
7. **Collecting turn / fan-out shape.** The engine is strictly one task at a time per room (`prepare_room` returns early if any task is queued/running/stopping). Parallel fan-out needs Hexbot-side scheduling.
8. **Approvals surfacing.** Polled through `groups.state`; usable as-is, but a push would need a core edit to `_report_pending_action`.
