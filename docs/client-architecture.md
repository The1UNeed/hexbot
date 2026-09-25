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

- `local`: the daemon this app spawned or found on 127.0.0.1. Token comes
  from the daemon's `/` page (`window.__HERMES_SESSION_TOKEN__`) when the
  gate is off, or from `~/.hexbot/local-device.token` via the bridge when
  the gate is on.
- `remote`: `{host, port, deviceToken}` obtained by pairing.

Connect sequence:

1. `GET http://host:port/` and read `__HERMES_AUTH_REQUIRED__`.
2. Gate off: open `ws://host:port/api/ws?token=<session token>`.
3. Gate on: `POST /api/auth/ws-ticket` with `Authorization: Bearer
   <deviceToken>`, then open `/api/ws?ticket=<ticket>` within 30 seconds.
4. Wait for the `gateway.ready` event; keep its `replay_epoch`.
5. Call `hexbot.info`, `hexbot.settings.get`, `hexbot.bots.list`.

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
| `status.update` | header status line |
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
