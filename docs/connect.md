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
2. **Daemon side**, `backend/hexbot-core/src/services.rs` and the
   `hexbot connect` CLI: registers the daemon, heartbeats, supervises
   `cloudflared`, and verifies grants. `server.rs` accepts grants through
   the app and browser sign-in flows.
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
minutes. Tunnels are locally managed: the daemon sets ingress to the
daemon's own loopback port, and Connect never sends an ingress config.

The daemon token alone cannot obtain connector credentials. Every registration
and replacement creates a unique `hexbot-<slug>-<random UUID>` tunnel name and
sets `tunnel_secret` to HMAC-SHA256 of that name, encoded as base64. Its key
comes from HKDF-SHA256 over the raw private scalar `d` of
`CONNECT_SIGNING_KEY_JWK`, with empty salt, UTF-8 info `hexbot tunnel secret v1`,
and 32-byte output. Development uses the same derivation from its ephemeral
signing key. Tunnels remain locally managed.

Repair requires both the daemon token and a connector token whose secret
matches that derivation. The token must name the current tunnel or a tunnel
whose name carries this daemon's slug. Cloudflare retains deleted tunnel
names, so a daemon can prove its old credentials and recover a replacement
whose response it missed. A token with an unknown tunnel ID cannot prove its
name and is refused.

Tunnels created before this change cannot be repaired. Their daemons need
`hexbot connect` again. Production has none because it has no Cloudflare
credentials yet. Rotating the signing key has the same effect on tunnel
repair, consistent with the registration requirement for signing-key rotation
below. Publishing an extra public key does not preserve the old tunnel-secret
derivation.

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
   `~/.hexbot/connect.json` (0600). On every `hexbot serve` the daemon
   downloads the pinned `cloudflared` into `~/.hexbot/bin/cloudflared-<version>`
   if missing, refusing a file whose SHA-256 differs from the pin, and runs
   it with a config file of its own (`~/.hexbot/cloudflared.yml`) whose only
   ingress rule is `http://127.0.0.1:<port>`, so neither Connect nor a
   `~/.cloudflared/config.yml` can point the tunnel elsewhere. The token
   travels in `TUNNEL_TOKEN`, not on the command line. The daemon retries a
   failed download or a crashed `cloudflared` with backoff, and repairs a
   tunnel that `cloudflared` cannot start at all (see "Tunnel repair"). The
   daemon stops its tunnel child during shutdown. Settings shows the tunnel as running
   only while `cloudflared` reports an edge connection on its `/ready`
   endpoint (see "Tunnel repair"). The tunnel supervisor and grant
   verification are native and require no separate Node sidecar. The
   daemon's login page offers "Sign in with Hex Connect". A
   `connect.json` from before owner pinning is ignored with a warning; run
   `hexbot connect` again.
5. Heartbeat: `POST /api/daemons/{id}/heartbeat {port}` every five minutes
   with the daemon token, the first one as soon as the tunnel starts; Connect
   records `last_seen_at` and the port, which only the loopback development
   address uses.

## Online state

A heartbeat says the daemon process is up; it says nothing about the tunnel,
which runs beside it and can be down while the daemon keeps checking in. So
whenever Connect lists daemons (`GET /api/daemons` and the `/connect` page) it
also probes each daemon's address: `GET https://<tunnel_hostname>/api/auth/providers`,
public, unauthenticated, served by every daemon version. The probe follows no
redirects, sends no credentials, times out after three seconds, reads at most
64 KiB of the body (a larger one is not a daemon), runs for all daemons in
parallel, and only ever targets hostnames from Connect's own rows. A 2xx JSON
answer with a `providers` list means reachable. With the fake tunnel provider
the probe goes to the daemon's loopback address instead. A reachable answer
is remembered for thirty seconds per address, an unreachable one for five, so
a daemon that just came up is not shown down for long.

Three states follow: **online** (heartbeat within ten minutes and the address
answers), **unreachable** (heartbeat within ten minutes, address does not
answer: the daemon runs but its tunnel is down), and **offline** (no heartbeat
for ten minutes; not probed). The API carries `status` plus the older
`online` boolean, which is true only for `online`. "Open in browser" and the
app's daemon list enable a daemon only while it is online.

## App sign-in

1. The app opens the system browser at
   `/connect/authorize?state=<random>&device=<name>`. After Clerk sign-in
   and an explicit click, Connect redirects to
   `hexbot://connect?state=<same>#session=<client session token>`. The token
   stays in the fragment; the Electron protocol handler delivers it.
2. `GET /api/daemons` with the client session token lists the user's daemons
   with online state (`status` and `online`, see "Online state").
3. Picking one: `POST /api/daemons/{id}/grant` → an ES256 JWT, `typ`
   `hexbot-grant+jwt`, `{iss, aud: daemon id, sub: user id, daemon_id,
   device_name, jti, exp: +5 min}` plus the daemon's address.
4. The app logs in to the daemon with the password-login route:
   `POST https://<host>/auth/password-login {provider: "hexbot", username:
   <device name>, password: "cg_<jwt>"}`. The `hexbot` provider treats a
   password starting with `cg_` as a grant: the daemon checks the pinned
   bindings (see Trust), the signature, and expiry, the daemon checks that
   the `jti` has not been seen, then mints a device token exactly as pairing
   does. The daemon caches Connect's published keys for ten minutes and
   refetches for an unknown key id at most once a minute. The desktop reads the token from the
   `hermes_session_at_<port>` cookie, or `__Host-hermes_session_at` over HTTPS.
5. From here it is a normal remote target: `{host, port: 443, tls: true,
   deviceToken}`.

## Browser sign-in

The core redirects an unauthenticated HTML request on a gated daemon to its own
`/login` page, so the daemon-served bundle never gets to run before sign-in.
Browser access therefore uses the core's OAuth-shaped provider flow, with
Connect as the identity provider:

1. "Open in browser" on `/connect` links to
   `https://<host>/auth/login?provider=connect&next=/`. The core calls
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
3. The core's `/auth/callback` checks the state cookie and calls
   `complete_login`, which posts `POST /api/grants/exchange {code,
   code_verifier, redirect_uri}` with the daemon's bearer token. Connect
   verifies the hash, expiry, daemon, verifier, and redirect URI, consumes
   the code, and returns a grant JWT. The daemon verifies it like an app
   grant, mints a device token with platform `connect`, and the core sets the
   session cookies and lands on `next`. When `dashboard.public_url` is an HTTPS
   origin and the request Host matches it, cookies use Secure even if the
   reverse proxy connects from another LAN host. Forwarded headers do not
   establish HTTPS trust.

Spent grant ids live in the daemon's SQLite database (`spent_grants`), so a
restart inside a grant's five minutes cannot replay it; grants are verified
with sixty seconds of clock leeway.

## Disconnecting and revoking

Disconnect in Settings and `hexbot connect disconnect` both run
`hexbot.connect.disconnect` inside the running daemon (the CLI talks to it over
its socket when one is up), so the tunnel stops, `connect.json` goes, the
public URL is cleared, and the login button disappears at once. The daemon
also tells Connect with `DELETE /api/daemons/{id}`.

Revoke on the dashboard is the reverse direction. Connect marks the row
revoked first, blocking repairs and grants, then deletes its tunnel and the
hostname's DNS records. It clears `tunnel_id` only after both succeed, with a
compare-and-set, and repeats if the ID changed. A cleanup failure returns 502
and leaves the revoked row with its tunnel ID. The dashboard shows "Removing…"
and a Retry action; the app's daemon list excludes it. Both the owner and the
daemon may retry DELETE. Already-deleted tunnels and missing DNS records count
as success. Other calls made with that daemon's token receive
`410 {error: "daemon_revoked"}`. An unknown token stays 401. The daemon treats that answer, and only that answer, as the owner's
decision: it drops the registration exactly as disconnect does, minus the
DELETE, and Settings shows "Not connected. Removed in Hex Connect." The
first heartbeat goes out when the tunnel starts and the rest every five
minutes, so a revoked daemon disconnects within a few minutes. A 401, a 5xx,
or an unreachable Connect never removes anything: a Connect outage must not
disconnect daemons.

## Tunnel repair

A tunnel deleted or rejected on Cloudflare's side used to leave the daemon
restarting `cloudflared` forever; only registering again helped, with a new
hostname and every saved target broken.

**Detection.** A gone tunnel does not make `cloudflared` exit quickly: it
retries for most of a minute before giving up, and an `Unauthorized` answer
keeps it retrying for ever. So the daemon runs `cloudflared` with
`--metrics 127.0.0.1:<free port>` and polls its `/ready` endpoint every five
seconds; 200 means at least one registered edge connection. Settings'
"Running" reflects the last probe result, including loss of readiness before
the restart deadline. Probes bypass HTTP proxies and each process gets a fresh
free metrics port. A failure is either no readiness for three minutes (since start, or since it was last ready; the
daemon stops that `cloudflared` itself) or an exit within five minutes of
start. A ready tunnel resets the failure count and restart backoff to one
second. Three failures in a row trigger a repair.

**The call.** `POST /api/daemons/{id}/tunnel` with the daemon token and body
`{tunnel_token}`, raced against shutdown so disconnect never waits on Connect.
Repairs use a 150-second base cooldown, longer than Connect's own cooldown.
While repairs keep not helping, the wait doubles, up to thirty minutes. Connect:

1. Claims the daemon's repair slot atomically before touching Cloudflare:
   `UPDATE daemons SET tunnel_repair_at = now() WHERE id = $1 AND revoked_at
   IS NULL AND (tunnel_repair_at IS NULL OR tunnel_repair_at < now() -
   interval '2 minutes') RETURNING id`, else `429 tunnel_recent`. Only this
   route references `tunnel_repair_at` (an additive, nullable column in
   `migrations.sql`), so every other route keeps working on a database that
   has not been migrated; until it is, repair answers 500 and the daemon
   simply keeps backing off.
2. Re-reads the row, returning 410 if revoked, and verifies the connector
   proof before any Cloudflare write. Missing, forged, foreign, or legacy
   credentials return 403.
3. If the current tunnel exists and is not deleted, re-points DNS at it.
   A proof for that same tunnel gets `{tunnel_hostname, replaced: false}`
   without a token. A stale proof gets the current token and `replaced: true`,
   recovering a missed replacement response.
4. If the current tunnel is deleted or unknown, creates a replacement with
   a unique name and derived secret, swaps `tunnel_id` with a compare-and-set
   requiring `revoked_at IS NULL`, then points DNS at it. A request that loses
   the swap deletes its own tunnel and uses the row's current tunnel.
5. After fetching any token and changing DNS, re-reads the row. If a revoke
   landed, it deletes the tunnel and hostname records and returns 410. On a
   failure it observes, it attempts to delete its own artifacts and returns
   502. It never delivers a replacement token after observing revocation.

This is not termination-safe. A repair invocation killed mid-flight after a
revoke can leave an inert orphan: a tunnel with no DNS and no delivered token,
or a CNAME pointing at a deleted tunnel. Failed cleanup is retried through
revoked rows while their tunnel ID remains recorded; unrecorded orphans need
operator cleanup. Ordering repair as claim, create, compare-and-set, DNS,
re-read minimizes this gap but cannot close it without durable job tracking.

The hostname never changes, so saved targets keep working. Only `tunnel_token`
is read from the request body; ingress stays on the daemon. On `replaced: true` the daemon writes the new token to `connect.json` (atomically, still
0600), restarts `cloudflared` with it, and resets its backoff and failure
count. On `replaced: false` nothing is rewritten and nothing is reset. A
`404` (a Connect that predates repair) or a `429` keeps the normal backoff; a
`410 daemon_revoked` drops the registration as described above.

## Connect API routes

- `POST /api/register/start`, `POST /api/register/poll`, `GET
  /connect/approve` (page), `POST /api/register/approve {user_code}`.
- `GET /api/daemons`, `POST /api/daemons/{id}/grant`, `POST
  /api/daemons/{id}/heartbeat`, `POST /api/daemons/{id}/tunnel` (daemon
  token; see "Tunnel repair"), `DELETE /api/daemons/{id}` (owner session or
  the daemon's own token), `POST /api/daemons/{id}/rename`.
- `POST /api/grants/exchange` (daemon token).
- `GET /connect/authorize` (page), `GET /api/me`, `DELETE /api/sessions/{id}`.
- `GET /.well-known/jwks.json`, `GET /api/health`.

Authentication: Clerk session for pages, server actions, and
`POST /api/register/approve`; bearer tokens for daemons and apps (hashes
stored; a revoked daemon's token answers `410 daemon_revoked`); the signing
key for grants in an environment variable. To rotate,
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
  addresses and device labels, online state with an injected probe, tunnel
  repair with the fake provider (existing tunnel re-pointed without a token,
  deleted tunnel replaced under its hostname, one repair per two minutes,
  compare-and-set race, revoke landing before and after the swap), consent
  parsing, CORS.
- Daemon (`backend/hexbot-core/tests/services.rs`, `server.rs`): registration
  with a local fake API, pinned owner/audience/issuer/keys, malformed and
  expired grants, single-use grants, PKCE exchange, tunnel lifecycle using a
  stand-in `cloudflared`, a `410 daemon_revoked` heartbeat dropping the
  registration while 401 and 5xx keep it, tunnel repair with a stand-in
  `cloudflared` that serves `/ready` (a replacement's token saved and used,
  `replaced: false` rewriting nothing, a never-ready tunnel stopped and
  counted as failed, 404 keeps the backoff, 410 drops the registration),
  and CLI disconnect against a running daemon (`tests/cli.rs`).
- Client: the `hexbot://connect` handler, the `tls` connection path, the
  prefixed cookie names.

Browser sign-in started on LAN, Tailscale, or localhost redirects to the registered
tunnel hostname before creating PKCE state or setting its cookie. Pending sign-ins
are capped at eight per client and 4096 globally. Pairing and grant attempts use
Cloudflare's client IP only for loopback peers with the registered tunnel Host;
IPv6 clients share a /64 rate-limit key.
