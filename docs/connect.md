# Connect

Hexbot's optional cloud service for reaching a daemon from outside the LAN.
Milestone 2. LAN pairing never depends on it. Decisions here follow
`DESIGN.md` section 4; where the design left gaps, the simplest option that
keeps Connect out of the data path was chosen.

## Shape

Three parts:

1. **Connect API**, `apps/connect`: Next.js on Vercel, Clerk for identity,
   Postgres (Neon) for state, the Cloudflare API for tunnels. AGPL like the
   rest of the repo. Free during beta.
2. **Daemon side**, `hexbot/connect.py` and `hexbot connect` CLI: registers
   the daemon with Connect, runs a `cloudflared` child process with the
   tunnel token, and accepts Connect grants for login.
3. **Client side**: Settings > Connect signs the user in, lists their
   daemons, and turns a pick into a normal remote connection target.

Traffic goes client → Cloudflare edge → `cloudflared` on the daemon host →
`127.0.0.1:<port>`. Connect only brokers identity and hostnames.

## Data model (Postgres)

- `users(id, clerk_user_id unique, created_at)`
- `daemons(id, user_id, name, slug unique, tunnel_id, tunnel_hostname,
  token_hash, created_at, last_seen_at, revoked_at)`
- `registrations(id, user_code, device_code_hash, daemon_name, user_id null
  until approved, expires_at, approved_at, consumed_at)`
- `client_sessions(id, user_id, token_hash, device_name, created_at,
  last_seen_at, revoked_at)`

## Daemon registration (device code)

1. `hexbot connect` calls `POST /api/register/start {daemon_name, platform}`
   → `{device_code, user_code, verify_url, interval}`. Prints the URL and the
   eight-character user code.
2. The user opens the URL, signs in with Clerk, approves the code.
3. The daemon polls `POST /api/register/poll {device_code}` until it gets
   `{daemon_token, daemon_id, slug, tunnel_token, tunnel_hostname}`. Connect
   creates the Cloudflare tunnel at approval time: one tunnel per daemon,
   hostname `<slug>.connect.hexbot.app`, ingress to `http://127.0.0.1:<port>`.
4. The daemon stores the daemon token and tunnel token in
   `~/.hexbot/connect.json` (0600), downloads a pinned `cloudflared` into
   `~/.hexbot/bin` if missing, and starts it as a supervised child on every
   `hexbot serve`. It sets Hermes `dashboard.public_url` to the tunnel
   hostname so the Host check passes and the auth gate turns on.
5. Heartbeat: `POST /api/daemons/{id}/heartbeat` every five minutes with
   the daemon token; Connect records `last_seen_at`.

## Client login and connection

1. The client opens the system browser at
   `https://hexbot.app/connect/authorize?state=<random>&device=<name>`.
   After Clerk sign-in, Connect redirects to
   `hexbot://connect?state=<same>#session=<client session token>`. The
   token stays in the fragment. The Electron protocol handler delivers it.
2. `GET /api/daemons` with the client session token lists the user's
   daemons with online state.
3. Picking one: `POST /api/daemons/{id}/grant` → a short-lived Connect grant,
   an ES256 JWT with `{sub: user id, daemon_id, device_name, exp: +5 min}`.
4. The client logs in to the daemon with the existing password-login route:
   `POST https://<slug>.connect.hexbot.app/auth/password-login
   {provider: "hexbot", username: <device name>, password: "cg_<jwt>"}`.
   The Hexbot auth provider treats a password starting with `cg_` as a
   Connect grant: it fetches Connect's JWKS (`/.well-known/jwks.json`,
   cached, refreshed on unknown key id), verifies the signature, expiry,
   and that `daemon_id` matches this daemon, then mints a device token
   exactly as pairing does. No core edits.
5. From here it is a normal remote target: `{host: <slug>.connect.hexbot.app,
   port: 443, tls: true, deviceToken}`. The client's connection code gains a
   `tls` flag (`https` and `wss`).

## Connect API routes

- `POST /api/register/start`, `POST /api/register/poll`, `GET /connect/approve`
  (page, Clerk protected), `POST /api/register/approve {user_code}`.
- `GET /api/daemons`, `POST /api/daemons/{id}/grant`,
  `POST /api/daemons/{id}/heartbeat`, `DELETE /api/daemons/{id}` (revokes
  the daemon token and deletes the tunnel), `POST /api/daemons/{id}/rename`.
- `GET /connect/authorize` (page, Clerk protected, issues the client
  session and redirects to the `hexbot://` link), `GET /api/me`,
  `DELETE /api/sessions/{id}`.
- `GET /.well-known/jwks.json`.

Authentication: Clerk session for pages, bearer tokens for daemons and
clients (sha256 hashes stored), signing key for grants in an environment
variable, rotated by adding a new key id.

## Operator requirements

Clerk application keys, a Cloudflare account with a zone for
`connect.hexbot.app` and an API token scoped to tunnels and DNS, a Neon
database URL, and the Vercel project. None of these exist on the build
machine today; the service is built and tested with an in-memory store, a
fake Cloudflare client, and a locally generated signing key.

## Tests

- Unit: token hashing, grant issue and verify (including expired, wrong
  daemon, unknown key id), device-code lifecycle, slug generation.
- Route tests with the in-memory store and the fake Cloudflare client.
- Daemon side: `hexbot/connect.py` registration state machine with a fake
  API, `cloudflared` supervision with a fake child, grant login through the
  auth provider with a locally signed JWT.
- Client: the `hexbot://connect` handler and the `tls` connection path.
