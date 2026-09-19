# Hex Connect

This workspace runs the identity and tunnel broker described in `docs/connect.md`. Daemon traffic does not pass through this app. It is deployed at `connect.hexbot.app`; the marketing site at `hexbot.app` is a separate Astro project in `apps/site`.

## Run locally

Copy `.env.example` to `.env.local`, set `DEV_USER_ID=local-user`, then run:

```bash
pnpm connect:dev
```

With no `DATABASE_URL`, the process uses an in-memory store. With incomplete Cloudflare credentials, it uses deterministic fake tunnels. With no `CONNECT_SIGNING_KEY_JWK`, it creates an ephemeral ES256 key and prints a warning. Data and signing keys reset when the process restarts.

Clerk is optional locally. When `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is absent, `DEV_USER_ID` is the signed-in user. The fallback only works in a development build (`next dev`); a production build ignores it on any host, so a deployment without Clerk rejects every sign-in.

`GET /api/health` reports which backends are active (`store`, `tunnels`, `auth`, `signing`) and `ready: true` only when all four are production ones.

Point a daemon at a local instance with `HEXBOT_CONNECT_URL=http://localhost:3000`, and the web bundle with `localStorage.setItem("hexbot.connect.url", "http://localhost:3000")`.

## Hostnames

Each daemon gets `<slug>.<CONNECT_DOMAIN>`, for example `amber-otter-1234.hexbot.app`. The name sits one label under the zone so Cloudflare's Universal SSL certificate (`*.hexbot.app`) covers it. Slugs are always `adjective-noun-number`, so they never collide with `connect` or `www`.

`CONNECT_INGRESS_PORT` is only the initial tunnel target. Every daemon heartbeat carries the port `hexbot serve` listens on, and the tunnel configuration is updated when it changes.

## End-to-end test

`HEXBOT_CONNECT_E2E=1 ./venv/bin/pytest tests/hexbot/test_connect_e2e.py` (from the repository root) starts this app with the in-memory store, runs a real daemon, and drives registration, sign-in, grant exchange, revocation, and disconnect.

## Database migration

Set `DATABASE_URL` to a Neon Postgres connection string, then run:

```bash
pnpm --filter ./apps/connect run migrate
```

The migration is idempotent. Run it before the first deployment and after schema changes.

## Deploy to Vercel

The Vercel project `hexbot-connect` is connected to the GitHub repository with its root directory at `apps/connect`. Every push to `main` deploys `connect.hexbot.app`; every other branch gets a preview URL, posted on the pull request. Nobody deploys by hand. `docs/deploy.md` describes both environments.

Production needs these environment variables, all from `.env.example`:

| Variable | Source |
| --- | --- |
| `CONNECT_BASE_URL` | `https://connect.hexbot.app` |
| `CONNECT_DOMAIN` | `hexbot.app` |
| `DATABASE_URL` | Neon project connection string |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Clerk application (production instance) |
| `CF_API_TOKEN` | Cloudflare API token with Account: Cloudflare Tunnel: Edit and Zone: DNS: Edit |
| `CF_ACCOUNT_ID`, `CF_ZONE_ID` | Cloudflare dashboard, zone `hexbot.app` |
| `CONNECT_SIGNING_KEY_JWK` | one line from `node scripts/make-signing-key.mjs` |

Do not set `DEV_USER_ID` in production. Run the migration against the production database, then redeploy from the Vercel dashboard, then confirm `https://connect.hexbot.app/api/health` returns `ready: true`.

DNS for `hexbot.app` must be a Cloudflare zone, because tunnel hostnames are Cloudflare DNS records. Keep the records that point `hexbot.app`, `www`, and `connect` at Vercel set to DNS only (not proxied).

CI runs the same checks Vercel builds against:

```bash
pnpm --filter ./apps/connect run typecheck
pnpm --filter ./apps/connect run test --run
pnpm --filter ./apps/connect run build
```
