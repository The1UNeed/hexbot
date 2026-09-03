# Hexbot authentication

Hexbot uses Hermes's dashboard authentication gate. A daemon bound to a LAN
address requires authentication. A loopback-only daemon does not.

## Loopback daemon

When the daemon binds to `127.0.0.1`, Hermes injects its process session token
and `window.__HERMES_AUTH_REQUIRED__ = false` into the web bundle. The local
browser uses that injected token. No pairing code or device cookie is needed.

## LAN browser

Run `hexbot pair`, then open the daemon in a browser. Hermes redirects an
unauthenticated browser to `/login`. Select "Hexbot pairing", enter a device
name as the username, and enter the eight-character pairing code as the
password.

`POST /auth/password-login` redeems the code once and sets these HTTP-only
cookies over plain HTTP:

- `hermes_session_at`, containing the long-lived Hexbot device token
- `hermes_session_provider`, containing `hexbot`

The browser sends the cookie to `POST /api/auth/ws-ticket`. Hermes returns a
single-use ticket valid for 30 seconds. The browser then opens
`/api/ws?ticket=<ticket>`.

## Electron remote daemon

Electron keeps authentication in its main process and does not use browser
cookies. The main process follows this sequence:

1. Send the device name and pairing code to `POST /auth/password-login` with
   provider `hexbot`.
2. Read the `hermes_session_at` value from the response's `set-cookie` header.
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
that token return 401. A ticket minted before revocation remains usable until
it is consumed or its 30-second lifetime ends. Revocation does not close an
already-open WebSocket.
