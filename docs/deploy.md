# Deploying hexbot.app

Two Vercel projects, both in the Vercel team that owns the `hexbot.app` domain:

| Project | Root directory | Domains | Stack |
| --- | --- | --- | --- |
| `hexbot-site` | `apps/site` | `hexbot.app`, `www.hexbot.app` | Astro, static |
| `hexbot-connect` | `apps/connect` | `connect.hexbot.app` | Next.js, serverless |

Deploy either one from its directory with `vercel deploy --prod`. Both directories are self-contained npm packages, so a deploy does not need the repository root.

## Site

The site has no secrets. `apps/site/vercel.json` sets the security headers and marks hashed assets immutable. Before deploying run `npm run check -w apps/site`.

Downloads: `apps/site/public/downloads/manifest.json` names the artifacts and has a `published` flag. The landing page renders inert buttons until it is `true`. The release workflow's `finalize` job rewrites the manifest and commits it to `main` after every stable release (`docs/release.md`); deploy the site afterwards so the buttons point at the new files.

Smoke check after a deploy: `https://hexbot.app/`, `/docs/`, `/docs/connect/`, `/pair/`, and `/privacy/` all return 200 with the security headers.

## Update server

`updates.hexbot.app` is a Cloudflare R2 bucket with a custom domain, nothing else. The release workflow uploads every package and the electron-updater feed files into it; the desktop app, the landing page, and the Homebrew casks all read from it. Layout and one-time setup are in `docs/release.md`. There is no code to deploy.

## Connect

Connect needs Clerk, Neon, Cloudflare, and a signing key. `apps/connect/README.md` lists every variable and where it comes from. Without them the deployment is a placeholder: every API call returns 401 and the pages say sign-in is unavailable. `GET /api/health` returns `ready: false` until all four backends are the production ones.

Order of operations for the first real deployment:

1. Move the `hexbot.app` nameservers to Cloudflare (free plan). Recreate the Vercel records there as DNS-only: `hexbot.app` A `76.76.21.21`, `www` and `connect` CNAME `cname.vercel-dns.com`. Confirm the Vercel domains show as verified afterwards.
2. Create a Cloudflare API token with Account: Cloudflare Tunnel: Edit and Zone: DNS: Edit for the zone. Note the account id and zone id.
3. Create a Clerk application with a production instance on `connect.hexbot.app` and add its DNS records in Cloudflare (DNS-only).
4. Create a Neon project and run `DATABASE_URL=... npm run migrate -w apps/connect`.
5. Generate the signing key: `node apps/connect/scripts/make-signing-key.mjs`.
6. Add every variable to the `hexbot-connect` project for Production, redeploy, and check `/api/health` says `ready: true`.
7. Register a daemon with `hexbot connect`, then sign in from a client-only app on another network.

The daemon and the app default to `https://connect.hexbot.app`. `HEXBOT_CONNECT_URL` (daemon) and the `hexbot.connect.url` local-storage key or `VITE_HEXBOT_CONNECT_URL` (web bundle) override it for a staging instance.
