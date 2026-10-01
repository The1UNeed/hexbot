# Hexbot authentication

Every daemon requires authentication, whatever address it binds. A browser
on the daemon's own computer signs in with a one-time link or a pairing code;
the app and the CLI read the private local token file.

Each WebSocket RPC resolves its user from the authenticated device's owner,
never from request parameters. Revoked devices and disabled users are
rejected.

## Browser on the daemon computer

The daemon never puts a credential in a page: any local process, including
a bot's shell command, can fetch `http://127.0.0.1:<port>/`. The web bundle
carries only `window.__HERMES_AUTH_REQUIRED__ = true`, and an HTML request
without a valid cookie is redirected to `/login`.

`hexbot serve` prints a one-time sign-in link at startup when it runs in a
terminal, and `pnpm dev` prints one for its dev server:

```
Sign in: http://127.0.0.1:9119/login?code=ABCD-EFGH
The link works once and expires in 10 minutes. Run `hexbot pair` for a new code.
```

The code is an ordinary pairing code. `GET /login?code=<code>` redeems it
once, creates a device named `Browser on this computer` (platform
`browser`), sets the session cookie described below, and redirects to the
app (`next`, same-origin only). It redeems only when the browser started the
navigation itself (`Sec-Fetch-Site` absent, `none`, or `same-origin`); a
link followed from another site shows the sign-in page with a notice and
leaves the code unused, so a page cannot sign a browser in as a device it
minted. A browser that already has a valid session is redirected to `next`
without redeeming, so a link never replaces an existing session. A used or
expired link shows the sign-in page with a notice (a separate one after too
many attempts); a new code comes from `hexbot pair` or Settings, Network. The daemon prints the link
only when its standard output is a terminal and no supervisor is present
(`HEXBOT_SUPERVISOR`, systemd's `INVOCATION_ID`, a launchd `XPC_SERVICE_NAME`),
so redirected daemon output and service logs receive no startup code.
`pnpm dev` follows the same terminal and supervisor checks.
An ordinary macOS shell may inherit `XPC_SERVICE_NAME=0`; this is not a
service name. Terminal recording or explicitly capturing `hexbot pair` output can still
retain a usable code. The dev runner and smoke scripts mint their links with
`hexbot pair` instead. Startup links leave outstanding pairing codes valid.

## LAN browser

Run `hexbot pair`, then open the daemon in a browser. The daemon redirects an
unauthenticated browser to `/login`. Enter a device name and the
eight-character pairing code.

`POST /auth/password-login` redeems the code once and sets an HTTP-only
cookie. Over plain HTTP it is `hermes_session_at_<port>`, containing the
long-lived Hexbot device token; the daemon port is part of the name because
browsers scope cookies by host, so two daemons on one machine (two `pnpm dev`
worktrees) would otherwise sign each other out. HTTPS through a configured
public URL or Hex Connect uses `__Host-hermes_session_at` with `Secure`. The daemon trusts that HTTPS
configuration only when the proxy connects from loopback and the Host matches.
A client-supplied `x-forwarded-proto` header alone does not enable Secure cookies.
The daemon also accepts the old `hermes_session_at` cookie during upgrades.

The browser sends the cookie to `POST /api/auth/ws-ticket`. The core returns a
single-use ticket valid for 30 seconds. The browser then opens
`/api/ws?ticket=<ticket>`.

## Electron remote daemon

Electron keeps authentication in its main process and does not use browser
cookies. The main process follows this sequence:

1. Send the device name and pairing code to `POST /auth/password-login` with
   provider `hexbot`.
2. Read the `hermes_session_at_<port>` (or `__Host-hermes_session_at`) value
   from the response's `set-cookie` header.
   This value is the device token. Store it in the operating system's secure
   credential store.
3. Send `Authorization: Bearer <device-token>` to
   `POST /api/auth/ws-ticket`.
4. Open `/api/ws?ticket=<ticket>` before the ticket expires.

Do not put the device token in a WebSocket URL.

## Electron local daemon

The local daemon creates one device named `This computer`. Its plain token is
stored in `<HEXBOT_HOME>/local-device.token` with mode `0600`; the database
stores only its SHA-256 hash. Electron reads this file, requests a WebSocket
ticket with the bearer flow above, then opens the WebSocket. If the file is
missing while its database row remains, Hexbot revokes the old row and creates
a new local device and token.

## Revocation

`hexbot devices revoke <id>` and `hexbot.devices.revoke` revoke the stored
device immediately. Future session checks and WebSocket-ticket requests using
that token return 401. Tickets are checked against the device again when
opening a WebSocket.
An already-open WebSocket closes after its next device check.

## Hex Connect grants

A Connect client requests a short-lived ES256 grant from hexbot.app, then uses
`cg_<jwt>` as the password in the existing `/auth/password-login` request. The
daemon verifies the grant against Connect's cached JWKS, checks that its
`daemon_id` claim names this daemon, and creates a normal revocable device with
platform `connect`. The grant never becomes a session token. The returned
`hxb_` device token follows the same cookie or bearer flow as LAN pairing.

User updates must leave at least one enabled admin. Disable or demote an admin
only after another enabled admin exists. Pairing limits track up to 4096 client
buckets, each allowing ten attempts per minute. When all buckets are occupied,
a new client replaces the least recently used bucket.
