# Hex Connect

This workspace runs the identity and tunnel broker described in `docs/connect.md`. Daemon traffic does not pass through this app.

## Run locally

Copy `.env.example` to `.env.local`, set `DEV_USER_ID=local-user`, then run:

```bash
npm run connect:dev
```

With no `DATABASE_URL`, the process uses an in-memory store. With incomplete Cloudflare credentials, it uses deterministic fake tunnels. With no `CONNECT_SIGNING_KEY_JWK`, it creates an ephemeral ES256 key and prints a warning. Data and signing keys reset when the process restarts.

Clerk is optional locally. When `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is absent, `DEV_USER_ID` is the signed-in user. Never use this fallback in production.

`CONNECT_INGRESS_PORT` sets the tunnel target port created during approval and defaults to `8000`.

## Database migration

Set `DATABASE_URL` to a Neon Postgres connection string, then run:

```bash
npm run migrate -w apps/connect
```

The migration is idempotent. Run it before the first deployment and after schema changes.

## Deploy to Vercel

Create a Vercel project rooted at `apps/connect`. Add every production variable from `.env.example`: Neon, both Clerk keys, all four Cloudflare values, the public base URL, and a private ES256 JWK. Do not set `DEV_USER_ID` in production. Run the migration against the production database, then deploy.

Check the workspace before deployment:

```bash
npm run typecheck -w apps/connect
npm run test -w apps/connect -- --run
npm run build -w apps/connect
```
