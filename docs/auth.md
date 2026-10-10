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

Electron makes pairing HTTP requests in its main process and returns the device
token to the renderer. The renderer saves it with the connection target in the
app profile. It follows this sequence:

1. Send the device name and pairing code to `POST /auth/password-login` with
   provider `hexbot`.
2. Read the `hermes_session_at_<port>` (or `__Host-hermes_session_at`) value
   from the response's `set-cookie` header.
   This value is the device token. The renderer stores it in localStorage.
3. Send `Authorization: Bearer <device-token>` and a fresh `DPoP` proof to
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

A daemon belongs to one person, the user `local`; every device, Connect
grant and pairing code is theirs. Pairing limits track up to 4096 client
buckets, each allowing ten attempts per minute. When all buckets are occupied,
a new client replaces the least recently used bucket.

## Device proof keys

New app clients generate a WebCrypto ECDSA P-256 key with a non-extractable
private key. IndexedDB stores the CryptoKey in the same app profile as the
saved connection target and token. One key serves that profile's remote
connections, including the full and client-only Electron editions. Clearing
the profile removes both. Copying only localStorage does not copy the key;
a token whose key has been lost must be paired again. This is software key
storage, not a hardware-backed credential store. Existing saved tokens and
the local daemon token remain unbound until a new login creates a device.

`POST /hexbot/pair` and `POST /auth/password-login` accept an optional `DPoP`
header. A valid proof binds the minted device to its RFC 7638 JWK thumbprint
in `devices.jkt`, added by the daemon's local SQLite migration. Missing proof
creates an unbound device for compatibility; supplied invalid proof fails.
A grant carrying `cnf.jkt` requires a matching proof even at login. A proof
on a `cg_<jwt>` login hashes that entire password string in `ath`.
Password-login responses include `device_token` and `device_id` only when a
proof is attached. A browser without key storage keeps only the HttpOnly
cookie; it does not save an unbound token in localStorage. Ordinary
daemon-served cookie login is unchanged. After a browser login returns no
token, the app immediately checks that the cookie can mint a ticket before
saving the target. If the browser blocks that cookie across sites, it directs
the user to the daemon's own address instead.

Proofs follow the JWT shape in [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html),
with header `{typ: "dpop+jwt", alg: "ES256", jwk: <public P-256 JWK>}` and
claims `htm`, `htu`, integer `iat`, unique `jti`, and `ath` whenever a token
is presented. `ath` is base64url SHA-256 of the exact token string. The
thumbprint follows [RFC 7638](https://www.rfc-editor.org/rfc/rfc7638.html).
`htu` has no query or fragment. The daemon checks method, path, and authority
including the port against the request's Host. Both authorities normalize
case, IPv6 brackets, and the proof URL scheme's default port. A different
non-default port is rejected. It ignores the transport scheme because
cloudflared forwards HTTPS as HTTP. Forwarded headers cannot change this
comparison. Clients sign HTTP(S) URLs even for a WebSocket upgrade.

Bound tokens require a valid proof at `POST /api/auth/ws-ticket`,
`POST /hexbot/session`, and direct `GET /api/ws` authentication through
Authorization, the legacy `token` query, or a cookie. An invalid proof never
falls back to another credential. Putting a bound token in a cookie does not
remove the binding. HTML page checks at `/`, `/login`, and SPA routes reject
bound tokens as cookie-only page sessions. Clients use the ticket flow because browser WebSocket
APIs cannot set a DPoP header. Tickets remain single-use bearer credentials
with a 30-second lifetime, checked again for device revocation at upgrade.
Established WebSockets recheck revocation, not the handshake proof on each RPC.

The daemon accepts `iat` within 60 seconds either side of its clock. It stores
used `(jkt, jti)` pairs in memory until `iat + 60`, including the full lifetime
of a proof accepted ahead of the daemon's clock. Restarting the daemon clears
this cache, so a captured proof can be replayed after restart while its
clock window remains open. Only authenticated, bound-token requests use the
cache, with at most 1,024 entries per key and 65,536 total. Login proofs are
not recorded: pairing codes and grants already have single-use protection,
persistent in SQLite. When a cache limit is reached, new authenticated
proofs receive retryable HTTP 503 until entries expire. Login remains available.

If WebCrypto or IndexedDB is unavailable, the client logs once and creates
an unbound login (cookie-only in browsers). Storage failures are retried on
the next request. The full edition's local unbound token does not need proofs.
A client cannot downgrade a token already bound by the daemon.
Plain HTTP browser origins outside localhost commonly lack WebCrypto; use
HTTPS for proof-capable remote browser clients. Old daemons ignore the header,
and their minted tokens remain unbound. Compatibility support means this is
opportunistic binding, not a mandatory deployment-wide policy.

Proof errors return `WWW-Authenticate: DPoP error="invalid_dpop_proof"` and
JSON `{error: "invalid_dpop_proof", code, message}`. HTTP 401 uses these codes:

- `invalid_dpop_proof`: malformed, invalid, or replayed proof.
- `dpop_proof_required`: a bound token or grant needs a proof.
- `dpop_key_mismatch`: the signing key does not match the binding.
- `dpop_clock_skew`: `iat` is outside ±60 seconds; `server_time` and
  `proof_time` give daemon and proof Unix timestamps in seconds.

`dpop_cache_full` uses HTTP 503 and `Retry-After: 1`. The app explains ticket
proof errors without deleting the saved target. Except for a key mismatch, it
keeps reconnecting with a fresh proof using the normal backoff, waiting at
least `Retry-After` when supplied. Clock errors show the difference between
the two clocks; check both devices, since either clock may be wrong. A lost or changed key sends the
app to pairing with the saved address and an explanation. Ordinary credential
401 responses still clear a revoked target. Storage errors remain HTTP 500
and do not look like revocation. A ticket HTTP 403 also retries without
clearing the target. See `docs/api.md` for the response contract.

DPoP protects against reuse of a stolen device token without its private key.
It does not hide traffic from Cloudflare, protect a compromised client that
can invoke its signing key, authenticate request bodies, or prevent an active
intermediary from racing a captured proof or ticket. Plain LAN HTTP is still
unencrypted. Connect session credentials are outside this device-token change.
A compromised Connect signing key still has to name the pinned owner, issuer,
and daemon and use a pinned, published key. It can impersonate that pinned
owner and mint a grant for an attacker's own proof key; DPoP does not remove
that signing authority.
