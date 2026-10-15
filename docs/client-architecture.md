# Client architecture

The web bundle in `apps/web` is the whole UI. Electron in `apps/desktop`
wraps it and adds native pieces over a small bridge. Read `docs/api.md` for
the daemon contract and `docs/auth.md` for auth flows.

## Stack

React 19, TypeScript strict, Vite, Tailwind v4, TanStack Router (file
routes), Base UI primitives, lucide icons, zustand for client state,
vitest and Testing Library for unit tests, Playwright for the Electron
end-to-end test. No Effect.

## Connection

A connection target is one of:

- `local`: the daemon this app spawned or found on 127.0.0.1. Inside
  Electron the token comes from `<HEXBOT_HOME>/local-device.token` via the
  bridge. In a browser the page came from the daemon (or the Vite dev server
  proxying it), and the HttpOnly session cookie set by the one-time sign-in
  link or the pairing form is the credential. The page itself never carries
  a token.
- `remote`: `{host, port, deviceToken}` obtained by pairing.

Connect sequence:

1. `GET http://host:port/` to reach the daemon; the bundle carries only
   `__HERMES_AUTH_REQUIRED__ = true`.
2. `POST /api/auth/ws-ticket` with `Authorization: Bearer <deviceToken>`
   (same-origin cookie in a browser), then open `/api/ws?ticket=<ticket>`
   within 30 seconds.
3. Wait for the `gateway.ready` event; keep its `replay_epoch`.
4. Call `hexbot.info`, `hexbot.settings.get`, `hexbot.bots.list`.

Daemon capabilities belong to the current target and replay epoch. Clear them
when that connection ends or changes, and publish `hexbot.info` independently
of other hydration RPCs. If info is unavailable, chat selection waits for a
successful info request before deciding whether create is safe on that daemon.

Reconnect with exponential backoff from 1 s to 16 s, forever, reset after
30 s stable. On reconnect, for every open live session call
`session.events.since {session_id, last_seen}`; if the returned epoch
differs from the stored one, drop live ids and reopen sections lazily.
A 401 on ws-ticket means the device was revoked: clear the target and show
the connect screen.

While the status is `reconnecting` (or `offline` on an app page)
`src/app/connection-lost.tsx` locks the window: the page underneath is
`inert` behind a full-window overlay with "Reconnect now" and "Connect to
another daemon". The connect and onboarding screens handle first contact
themselves, so `offline` never covers them; `reconnecting` covers everything
except the connect screen.

The RPC client is `@hermes/shared`'s `JsonRpcGatewayClient` wrapped in
`src/lib/rpc.ts`. Events arrive as notifications with method `event`;
`src/lib/events.ts` routes them by `params.session_id` to the transcript
store and by `params.type` for global events (`hexbot.*.changed`).

## Stores (zustand)

- `connection`: target, status (`idle | connecting | connected |
  reconnecting | unauthorized | offline`), attempt count, daemon info.
- `bots`: map by name, from `hexbot.bots.list`; refreshed on
  `hexbot.bots.changed`.
- `sections`: map by id, per bot; refreshed on `hexbot.sections.changed`;
  `liveSessionId` per open section.
- `transcripts`: per live session id: ordered messages, streaming buffer,
  pending tool calls, pending approvals, usage. Messages are
  `{id, role, text, streaming, toolCalls, attachments, createdAt}`; a tool
  call is `{toolId, name, args, result, status, startedAt, durationS}`.
- `settings`: deployment settings from `hexbot.settings.get`, providers,
  network, devices.
- `ui`: theme, right panel open, sidebar width, last opened section, all
  persisted to localStorage.

Only the transcript store is hot; everything else is small.

A catalog live ID does not mean its history has loaded. Only `sections.open`
registers a chat as loaded; list refreshes and canonical lookups leave that
registration alone. A report reload discards it and its transcript, including
when the chat is offscreen. Concurrent history opens share a request and reread
if another report invalidates the snapshot before it arrives.

Roster selections and Dream log entries resolve the daemon's canonical chat
on activation. Older daemons use the same explicit chooser and persist a pick
before opening it. Later navigation, unmount, or a daemon change cancels the
lookup before any further writes or navigation. Mobile omits a bot card's quote
when multiple preserved owner conversations make its source uncertain.

## Event mapping

| event | store action |
|---|---|
| `message.start` | begin assistant message (streaming) |
| `message.delta` | append text |
| `message.interim` | append commentary text if `already_streamed` is false |
| `message.complete` | finalize, attach usage, call `hexbot.sections.touch` |
| `reasoning.delta` | append to the message's reasoning trace, shown in the work panel |
| `thinking.delta` | replace the daemon's status line (a wait notice); spinner copy is dropped |
| `tool.start` / `tool.complete` | add or resolve a tool call in the current assistant message |
| `approval.request` | push an approval card (session scoped) and notify |
| `status.update` | header status line; `checking` replaces the live status with "Checking this step" until an empty `checking` line |
| `session.info` | update section's model and provider chips |
| `session.usage` | usage badge |
| `error` | inline error row |

Sending: `prompt.submit {session_id, text}`; before it, attachments are
staged with `image.attach_bytes` (images) or `file.attach {data_url,
name}` (other files) or `pdf.attach`. Stop: `session.interrupt`.

## Routes

- `/` redirects to the last opened section or to onboarding.
- `/b/$bot/s/$section` the three-column app.
- `/connect` pairing and address entry.
- `/onboarding/*` first-launch steps. The root layout also sends a connected
  user here once when their About you was never written, so the init page
  (name, what you do, preferences) runs at startup for existing installs too.
- `/settings/$tab` rendered as a dialog over the current route.

## Electron bridge (`window.hexbot`)

Exposed by the preload with contextIsolation on:

- `platform`, `version`, `isPackaged`.
- `daemon.status()`, `daemon.start()`, `daemon.stop()`,
  `daemon.onProgress(cb)` for the local runtime install and start.
- `daemon.localToken()` reads `~/.hexbot/local-device.token`.
- `pair(host, port, code, deviceName)` performs the password-login from
  the main process and returns the device token.
- `notify({title, body, sectionId})` shows a native notification; clicking
  focuses the window and navigates.
- `openExternal(url)`, `pickFiles()`.
- `updater.state()`, `updater.check()`, `updater.download()`, `updater.install()`,
  `updater.setChannel(track)`, `updater.onStatus(cb)`. `stores/updates.ts`
  mirrors the state; `app/update-pill.tsx` shows it in the roster.
- `service.install()`, `service.status()` for launchd or systemd.

In a plain browser `window.hexbot` is undefined and the UI hides the
native-only controls.

## Testing

- Unit: stores and event mapping with recorded event fixtures; the RPC
  wrapper against a fake WebSocket.
- Component: composer, transcript rendering of streaming and tool calls,
  approval card.
- End to end: Playwright drives the packaged Electron app against a
  daemon started in a temp home with a stub provider: connect, create a
  bot, send a message, see a reply.

Ordinary bot-chat URLs resolve the daemon's chat before showing history or enabling
input, including restored URLs and already-loaded live IDs. Explicit teammate
threads keep their own route and accept only answers to existing approval and
question cards. Metadata or open failures offer Retry. The same
navigation and daemon guards cover closing bot settings, so a late lookup cannot
pull the user out of a later room or route. Mobile Pulse opens a waiting teammate
thread's approval or question on its own live ID; ordinary bot taps still open
the canonical owner chat. Reconnects discard old chooser state, and a fresh
modern capability never accepts a stale ordinary chooser row as canonical.

Closing settings for a deleted bot clears only that bot's remembered chat and
leaves through the normal Home route. A later navigation or daemon change
cancels that exit, including while chat selection is waiting.

Mobile reconnect resolves an ordinary owner route through the daemon before
restoring history or enabling input, even when its old row still exists. A
failed lookup keeps input closed and offers Retry. Explicit peer threads and
rooms keep their own routes; older daemons keep their remembered explicit pick.

Onboarding's initial decision, Continue retry and first-bot creation use the
same route and daemon guard. Leaving that visit prevents later chat selection,
remembered-selection updates, navigation and bot introduction from its replies.
