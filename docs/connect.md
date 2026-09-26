# Connect

Hexbot's optional cloud service for reaching a daemon from outside the LAN.
LAN pairing never depends on it. Decisions here follow `DESIGN.md` section 4;
where the design left gaps, the simplest option that keeps Connect out of the
data path was chosen. The user-facing description is
`apps/site/src/pages/docs/connect.md`; the legal texts are `/terms/`,
`/privacy/`, `/acceptable-use/`, and `/security/` on the site.

The shape borrows from T3 Code's T3 Connect: the broker is never in the hot
path, the daemon pins the owner and the keys it trusts when it links, tunnel
ingress is decided on the daemon, credentials the browser sees are useless
without a secret the daemon holds, every grant is single-use, and the CLI,
the app, and the browser all end in the same revocable device token on the
daemon.

## Shape

Three parts:

1. **Connect service**, `apps/connect`: Next.js on Vercel, Clerk for
   identity, Postgres (Neon) for state, the Cloudflare API for tunnels,
   PostHog for product analytics (consent-gated, shared project with the
   site). AGPL like the rest of the repo. Free during beta.
2. **Daemon side**, `hexbot/connect.py`, `hexbot/auth_provider.py`, and the
   `hexbot connect` CLI: registers the daemon, heartbeats, and accepts
   Connect grants for login through two Hermes auth providers (`hexbot` for
   apps, `connect` for browsers). A TypeScript sidecar,
   `hexbot/connect_agent.mts`, supervises `cloudflared` and verifies grants.
   It runs on Node 24 or newer; the desktop app passes its own Electron
   binary as `HEXBOT_NODE`, so the full package needs no separate Node.
3. **Client side**: the app's connect screen signs in through the system
   browser, lists daemons, and turns a pick into a normal remote target;
   Settings, Connect registers the daemon and links to its address.

Traffic goes client → Cloudflare edge → `cloudflared` on the daemon host →
`127.0.0.1:<port>`. Connect never carries it. Cloudflare terminates TLS at its
edge, so Cloudflare, and whoever controls the Connect Cloudflare account, can
read that traffic; LAN pairing and Tailscale are the paths that avoid it.

## Trust

Connect signs the grants that log devices in, so its signing key is the one
secret that could open a daemon. The daemon narrows what that key can do: it
accepts a grant only if it names the owner and issuer pinned at registration,
names this daemon as its audience, and is signed by a key that was pinned at
registration and is still published. A Connect account other than the owner
cannot log in, and a key dropped from the JWKS stops working within ten
minutes. Tunnels are locally managed: the sidecar sets ingress to the
daemon's own loopback port, and Connect never sends an ingress config.

## Data model (Postgres)

- `users(id, clerk_user_id unique, created_at)`
- `daemons(id, user_id, name, slug unique, tunnel_id, tunnel_hostname,
  ingress_port, token_hash, created_at, last_seen_at, revoked_at)`
- `registrations(id, user_code, device_code_hash, daemon_name, platform,
  ingress_port, user_id null until approved, expires_at, approved_at,
  consumed_at, daemon_id)`: no secrets; cleared a day after expiry.
- `client_sessions(id, user_id, token_hash, device_name, created_at,
  last_seen_at, revoked_at)`: apps signed in with the account.
- `grant_codes(id, code_hash, daemon_id, user_id, device_name, challenge,
  redirect_uri, created_at, expires_at, consumed_at)`: one-time codes for
  browser sign-in.

Tokens are stored only as SHA-256 hashes. Registrations hold none: the
daemon token is minted, and the tunnel token fetched from Cloudflare, when
the daemon collects its registration. `src/lib/migrations.sql` is idempotent;
`pnpm --filter ./apps/connect run migrate` applies it.

## Pages

`/` (landing, redirects a signed-in user to `/connect`), `/sign-in` and
`/sign-up` (Clerk components), `/connect` (daemons with online state, open in
browser, rename, revoke; apps signed in, sign out), `/connect/approve` (the
device-code page), `/connect/authorize` (the app hand-off), and
`/connect/browser` (the browser sign-in hop, below). Pages that need a
signed-in user render Clerk's sign-in card in place with `forceRedirectUrl`
back to the same URL, so a code or a PKCE request survives the round trip.

Without a Clerk key, `DEV_USER_ID` is the signed-in user in `next dev` only.
With the fake tunnel provider (no Cloudflare credentials) every daemon's
address is `http://127.0.0.1:<ingress port>`, the port the tunnel would
forward to, so the whole flow runs on one machine.

## Daemon registration (device code)

1. `hexbot connect [--name NAME]` calls `POST /api/register/start
   {daemon_name, platform}` → `{device_code, user_code, verify_url,
   interval}` and prints the URL and the eight-character code. The app does
   the same through `hexbot.connect.register_start`.
2. The user opens the URL, signs in with Clerk, approves the code.
3. The daemon polls `POST /api/register/poll {device_code}` until it gets
   `{daemon_token, daemon_id, slug, tunnel_token, tunnel_hostname, owner_id,
   issuer, keys}`. Connect creates the Cloudflare tunnel at
   approval time: one locally managed tunnel per daemon, hostname
   `<slug>.<CONNECT_DOMAIN>` with a slug of 64 random bits.
4. The daemon stores the tokens, the owner, the issuer, and the keys in
   `~/.hexbot/connect.json` (0600). On every `hexbot serve` the sidecar
   downloads the pinned `cloudflared` into `~/.hexbot/bin/cloudflared-<version>`
   if missing, refusing a file whose SHA-256 differs from the pin, and runs
   it with a config file of its own (`~/.hexbot/cloudflared.yml`) whose only
   ingress rule is `http://127.0.0.1:<port>`, so neither Connect nor a
   `~/.cloudflared/config.yml` can point the tunnel elsewhere. The token
   travels in `TUNNEL_TOKEN`, not on the command line. The sidecar retries a
   failed download or a crashed `cloudflared` with backoff and exits, taking
   `cloudflared` with it, when the daemon's pipe to it closes. The heartbeat
   restarts a sidecar that died, and a new sidecar first stops any
   `cloudflared` its killed predecessor left running with this daemon's
   config. Settings shows the tunnel as running only while `cloudflared`
   itself is up. Without Node the daemon serves on and logs that the tunnel
   did not start. The daemon also sets Hermes
   `dashboard.public_url` to the tunnel hostname (which turns the auth gate
   on whatever the bind) and registers the `connect` auth provider so the
   daemon's login page offers "Sign in with Hex Connect". A
   `connect.json` from before owner pinning is ignored with a warning; run
   `hexbot connect` again.
5. Heartbeat: `POST /api/daemons/{id}/heartbeat {port}` every five minutes
   with the daemon token; Connect records `last_seen_at` and the port, which
   only the loopback development address uses. Ten minutes without one
   shows as offline.

## App sign-in

1. The app opens the system browser at
   `/connect/authorize?state=<random>&device=<name>`. After Clerk sign-in
   and an explicit click, Connect redirects to
   `hexbot://connect?state=<same>#session=<client session token>`. The token
   stays in the fragment; the Electron protocol handler delivers it.
2. `GET /api/daemons` with the client session token lists the user's daemons
   with online state.
3. Picking one: `POST /api/daemons/{id}/grant` → an ES256 JWT, `typ`
   `hexbot-grant+jwt`, `{iss, aud: daemon id, sub: user id, daemon_id,
   device_name, jti, exp: +5 min}` plus the daemon's address.
4. The app logs in to the daemon with the password-login route:
   `POST https://<host>/auth/password-login {provider: "hexbot", username:
   <device name>, password: "cg_<jwt>"}`. The `hexbot` provider treats a
   password starting with `cg_` as a grant: the sidecar checks the pinned
   bindings (see Trust), the signature, and expiry, the daemon checks that
   the `jti` has not been seen, then mints a device token exactly as pairing
   does. The sidecar caches Connect's published keys for ten minutes and
   refetches for an unknown key id at most once a minute. The desktop reads the token from the
   `hermes_session_at` cookie, prefixed `__Host-` over HTTPS.
5. From here it is a normal remote target: `{host, port: 443, tls: true,
   deviceToken}`.

## Browser sign-in

Hermes redirects an unauthenticated HTML request on a gated daemon to its own
`/login` page, so the daemon-served bundle never gets to run before sign-in.
Browser access therefore uses Hermes's OAuth-shaped provider flow, with
Connect as the identity provider:

1. "Open in browser" on `/connect` links to
   `https://<host>/auth/login?provider=connect&next=/`. Hermes calls
   `HexConnectProvider.start_login`, which makes a `state` and a PKCE
   verifier, stores both in the PKCE cookie, and 302s the browser to
   `/connect/browser?daemon=<id>&state=<state>&code_challenge=<S256>&redirect_uri=https://<host>/auth/callback`.
2. `/connect/browser` checks the daemon exists, the challenge shape, and that
   `redirect_uri` is exactly the daemon's own callback (a code never goes
   anywhere else). A signed-out visitor gets Clerk's sign-in card and comes
   back to the same URL. The daemon's owner is redirected at once to
   `<redirect_uri>?code=hxg_…&state=<state>`; the code row holds the
   challenge, the redirect URI, and a device label from the user agent
   ("Safari on iPhone"). Codes expire in five minutes.
3. Hermes's `/auth/callback` checks the state cookie and calls
   `complete_login`, which posts `POST /api/grants/exchange {code,
   code_verifier, redirect_uri}` with the daemon's bearer token. Connect
   verifies the hash, expiry, daemon, verifier, and redirect URI, consumes
   the code, and returns a grant JWT. The daemon verifies it like an app
   grant, mints a device token with platform `connect`, and Hermes sets the
   session cookies and lands on `next`.

Spent grant ids live in the daemon's SQLite database (`spent_grants`), so a
restart inside a grant's five minutes cannot replay it; grants are verified
with sixty seconds of clock leeway.

`hexbot connect disconnect` unregisters the provider in the process that runs
it: disconnecting from the app's Settings (RPC) takes effect at once, while the
CLI run against a live daemon leaves the button on that daemon's login page
until it restarts (clicking it answers 503, since the config is gone).

## Connect API routes

- `POST /api/register/start`, `POST /api/register/poll`, `GET
  /connect/approve` (page), `POST /api/register/approve {user_code}`.
- `GET /api/daemons`, `POST /api/daemons/{id}/grant`, `POST
  /api/daemons/{id}/heartbeat`, `DELETE /api/daemons/{id}` (owner session or
  the daemon's own token), `POST /api/daemons/{id}/rename`.
- `POST /api/grants/exchange` (daemon token).
- `GET /connect/authorize` (page), `GET /api/me`, `DELETE /api/sessions/{id}`.
- `GET /.well-known/jwks.json`, `GET /api/health`.

Authentication: Clerk session for pages, server actions, and
`POST /api/register/approve`; bearer tokens for daemons and apps (hashes
stored); the signing key for grants in an environment variable. To rotate,
publish the next public key in `CONNECT_JWKS_EXTRA`; daemons registered from
then on pin both, and older daemons register again after the swap. API
routes answer CORS for any origin.

## Analytics

`src/instrumentation-client.ts` loads `src/lib/analytics.ts`, which mirrors
the site's `analytics.ts`: PostHog starts opted out, the choice lives in
localStorage under `hexbot-analytics`, and nothing loads until Accept. With
consent it sends page views, autocaptured clicks, Core Web Vitals, uncaught
exceptions, session recordings (inputs masked), and the product events
`connect_daemon_approved`, `connect_client_authorized`,
`connect_browser_signin_prompted`, `connect_daemon_opened`,
`connect_daemon_renamed`, `connect_daemon_revoked`, and
`connect_device_revoked`, identified by the Clerk user id. Every URL property is cut to its path before
it is sent, session replay is off on `/connect/approve`, `/connect/authorize`,
and `/connect/browser`, element attributes are masked, and the hexbot:// link
is opened from state rather than rendered. Traffic goes through the
`/ingest` route handler, which forwards no cookies. `docs/deploy.md` describes
the project and dashboard.

## Operator requirements

Clerk application keys, a Cloudflare account with a tunnel zone of its own
(`CONNECT_DOMAIN`, never `hexbot.app`) and an API token scoped to tunnels and
that zone's DNS, a Neon database URL, a signing key, the
PostHog project key, and the Vercel project. The service is built and tested
with an in-memory store, a fake Cloudflare client, and a locally generated
signing key.

## Tests

- Unit (`apps/connect/src/__tests__`): token hashing, grant issue and verify
  (expired, wrong daemon, unknown key id, `jti`), device-code lifecycle, slug
  generation, the browser sign-in decision table and code exchange, daemon
  addresses and device labels, consent parsing, CORS.
- Sidecar (`tests/hexbot/connect_agent.test.mts`, `node --test`): pinned
  owner, audience, issuer, type, and keys; a pinned key no longer published;
  forged, expired, and malformed grants; a damaged or future-dated key cache;
  a `cloudflared` download that fails its pin.
- Daemon side (`tests/hexbot/test_connect.py`, `test_auth_provider.py`):
  registration state machine with a fake API, the real sidecar running a
  stand-in `cloudflared` (loopback ingress, token off argv, exit on EOF),
  grant login through both providers with locally signed JWTs, single-use
  grants, PKCE start and exchange, provider registration, serving on without
  Node.
- Client: the `hexbot://connect` handler, the `tls` connection path, the
  prefixed cookie names.
- End to end (`HEXBOT_CONNECT_E2E=1`): a real Connect dev server with the
  in-memory store, a real daemon, and every HTTP call the CLI, the app, and a
  browser make, including the browser sign-in round trip.
