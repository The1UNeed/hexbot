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

## Authorized startup cache

IndexedDB keeps a roster, recent room logs, and the last 50 opened chat histories
per daemon address. A cold launch reads none of this personal data until the
WebSocket has authenticated and `hexbot.info` has verified the install identity.
An identity change discards that address's old cache. A cold offline launch stays
empty until authorization succeeds; an already authorized view can keep its
messages behind the disconnected overlay.

Cached sections and bot recents carry no live session IDs. Running turns, cards
and activity are always read from the daemon. Chat routes still resolve the
canonical chat, and every open performs its normal history read and pending-card
reconciliation. The cache fills the wait after authorization, then the network
snapshot replaces it using the existing input and fragment identities. A retained
transcript takes precedence over cached rows during reloads. Inputs submitted
during a read cannot be matched to older occurrences by text alone.
Cached and fresh history use the same projection to hide interrupted kickoff prompts.

Each cached history keeps a recent suffix of at most 500 raw rows and 512 KiB
of JSON, with an oversized row omitted. Older history remains on the daemon.
Completed turns refresh kept histories after a two-second debounce. Whole
read/fetch/write operations are serialized per connection and chat; cache writes
alone would allow a slow old response to replace a newer snapshot. Invalidation
is checked again after persistence, and queued writes check it before committing.
Removing a section invalidates its pending reads and writes, even if listed again.
This client uses full-history reads, so it also works with daemons without history
cursors.
Room logs resume only from a verified contiguous baseline; a live event alone
never establishes one. Startup fetches and restores logs for at most 20 recently
active rooms; opening another room reads its log on demand. Persistence keeps only
those 20 logs, with each retained tail bounded by the same row/byte caps. The
fresh roster is published before optional log reads; each log succeeds or fails
independently. Room, section, and bot catalogs reserve authority order before
each request. Mutation replies retain that order, so a held response cannot outrank a newer
tombstone, list, lookup, or successful mutation. Lists account for pending IDs
absent from memory too. Older lists cannot delete a chat created while they
waited; newer lists invalidate older cold lookups even when the result is empty.
Cache restoration captures catalog authority before reading IndexedDB and fills
only IDs still unproven by the network. Cache readiness never establishes absence.
Room views observe explicit present, gone, or discarded outcomes, so concurrent
settings and conversation reads cannot mistake a superseded reply for deletion.
Live deletion, departure, archival, and membership updates invalidate older reads
and optional logs. Read acknowledgments only advance existing member read
positions; they never supersede pending history or overwrite room metadata.
Opening a room publishes its log without waiting for a best-effort acknowledgment.
Delayed permission failures also retain their original request order.

Roster subscriptions start after authorization. Persistence waits for the room
list, independently of optional logs or other startup reads. Queued roster and
log writes also check the room state they captured before committing.
Each roster write prunes persisted logs for deleted, departed, and archived rooms,
including rooms removed while the client was offline. Full section lists also
scan persisted history keys and the recency index, pruning disk-only deleted
chats while preserving work started after the list request. Cleanup uses the
active authorization generation, just like other cache writes.

A discarded startup room read is not evidence that the room is gone. Room views
retry when the connection opens, and only a current connection's completed read
can send a missing room back home.

Teardown invalidates pending cache work and stops roster subscriptions. A ticket
401, gateway revocation, or rejected device key also clears cached data and
personal stores. Queued writes and history replies cannot restore it afterward.
The cache is best effort: blocked IndexedDB or quota failures leave normal
network loading in place.

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
registration alone. A report reload drops that registration, including when
the chat is offscreen; the transcript stays on screen until the next read
replaces it, and is dropped only if it is still empty. Concurrent history opens share a request and reread
if another report invalidates the snapshot before it arrives.

Roster selections and Dream log entries resolve the daemon's canonical chat
on activation. Older daemons use the same explicit chooser and persist a pick
before opening it. Later navigation, unmount, or a daemon change cancels the
lookup before any further writes or navigation. Mobile omits a chat row's preview
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
| `approval.resolved` / `approval.expire` | show that card's answer / drop it while unanswered |
| `clarify.request` / `clarify.resolved` / `clarify.expire` | push a question card / show its answers / freeze it |
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

Closing the app window keeps its page and daemon connection alive in both
editions. Full keeps an app-owned daemon running; Client keeps receiving
notifications from its remote daemon. Chromium keeps its default background
throttling. Reply completions request a background-only native notification;
the main process checks whether the window is hidden or minimized at delivery
time. Browser reply notifications use the page's visibility.
macOS hides the window as before. Windows hides it to the tray, or minimizes
if tray setup fails. Linux always minimizes, because a tray object does not
prove that the desktop displays an icon, including on GNOME without a tray
extension. Use the dock or task switcher to restore the same page. The app
also restores it when it receives an activation or second-launch event, or
when you use the tray. Delivery of activation and second-launch events on
Linux depends on the desktop; GNOME Wayland has not been verified.
Windows and Linux have File > Quit as well as tray Quit.
Explicit quit, updater installation, Windows session end, and macOS/Linux
shutdown bypass close interception. The app never delays OS session events.
Desktop state patches are serialized per file so concurrent bounds and
settings changes preserve one another.

Exposed by the preload with contextIsolation on:

- `platform`, `version`, `isPackaged`.
- `daemon.status()`, `daemon.start()`, `daemon.stop()`,
  `daemon.onProgress(cb)` for the local runtime install and start.
- `daemon.localToken()` reads `~/.hexbot/local-device.token`.
- `pair(host, port, code, deviceName)` performs the password-login from
  the main process and returns the device token.
- `notify({title, body, sectionId, backgroundOnly?})` shows a native notification;
  background-only requests stay silent while the window is visible and not
  minimized. Clicking focuses the window and navigates.
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
