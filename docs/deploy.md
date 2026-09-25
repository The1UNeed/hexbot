# Deploying hexbot.app

Two Vercel projects, both in the Vercel team that owns the `hexbot.app` domain, both connected to the `The1UNeed/hexbot` GitHub repository:

| Project | Root directory | Domains | Stack |
| --- | --- | --- | --- |
| `hexbot-site` | `apps/site` | `hexbot.app`, `www.hexbot.app` | Astro, static |
| `hexbot-connect` | `apps/connect` | `connect.hexbot.app` | Next.js, serverless |

## Environments

Vercel deploys from Git. Nobody runs `vercel deploy` by hand.

- **Production**: every push to `main` builds both projects and moves `hexbot.app` and `connect.hexbot.app` to the new build once it is ready. A failed build leaves the previous deployment in place.
- **Preview**: every push to any other branch builds both projects at a preview URL, and Vercel comments the URLs on the pull request. A preview is `<project>-git-<branch>-the1uneeds-projects.vercel.app` and is public.

Each `vercel.json` pins the install command to `pnpm install --frozen-lockfile --filter <package>...`, run inside the root directory; pnpm finds the workspace root above it and installs only that package and its dependencies, so a site build installs a few hundred packages, not Electron or the web bundle. Vercel picks pnpm from `pnpm-lock.yaml`; set `ENABLE_EXPERIMENTAL_COREPACK=1` on both projects so it uses the exact version pinned by `packageManager` in the root `package.json`. Vercel's monorepo skipping for pnpm workspaces cancels the project a commit did not touch: a change under `apps/site/` only builds the site, a change under `apps/connect/` only builds Connect, and a change outside `apps/` builds both. Project settings (root directory, Git connection, domains, environment variables) live in the Vercel dashboard; `vercel.json` in each directory holds what can be versioned (headers, install and build commands).

Rolling back is a Vercel action: Deployments, pick the previous production deployment, Promote to Production.

Both projects measure visitors with PostHog (US cloud), one project for both so a single dashboard covers hexbot.app and Connect. Vercel Web Analytics and Speed Insights are not used; keep both toggles off on the Vercel projects. The site loads `posthog-js` from `apps/site/src/scripts/analytics.ts` and Connect from `apps/connect/src/lib/analytics.ts` (through `src/instrumentation-client.ts`), and both show the same cookie notice and store the answer under the same localStorage key, so nothing loads before the visitor accepts. With consent they send page views, autocaptured clicks, Core Web Vitals, uncaught exceptions, and session recordings with inputs masked. The site adds a `download` event for every build link (`edition`, `os`, `arch`, `format`, `version`, `channel`, `trigger`); Connect adds its product events (listed in `docs/connect.md`) identified by the Clerk user id.

Traffic goes through first-party `/ingest` rewrites (`apps/site/vercel.json` for the site, `next.config.ts` for Connect), so each CSP stays `'self'` and ad blockers see a first-party request. The site's rewrites capture with `(.*)`, not `:path*`: on Vercel `:path*` does not match a path ending in `/`, and posthog-js sends everything to such paths (`/e/`, `/i/v0/e/`, `/flags/`, `/s/`). Connect uses Next's own rewrites with `skipTrailingSlashRedirect`. The project key is public by design: `PUBLIC_POSTHOG_KEY` on `hexbot-site` and `NEXT_PUBLIC_POSTHOG_KEY` on `hexbot-connect`, both for Production only, so previews and local builds show no notice and send nothing. The pairing page opts out (`analytics={false}`) because its URL carries the daemon address and pairing code. The PostHog project lists `hexbot.app`, `www.hexbot.app`, and `connect.hexbot.app` as authorised URLs and filters internal traffic by `$host`; the pinned "Hexbot" dashboard has a section per surface. `/privacy/` describes what is collected; keep it in step with this.

## Site

The site has no secrets; the PostHog project key is public by design. `apps/site/vercel.json` sets the security headers and marks hashed assets immutable. CI runs `pnpm --filter ./apps/site run check` on every push, and Vercel builds the same commit.

Downloads: `apps/site/public/downloads/manifest.json` names the stable artifacts and has a `published` flag. While it is `false` the download page (`apps/site/src/pages/download.astro`) says stable is coming soon and offers the current nightly instead: `apps/site/src/lib/nightly.ts` reads the `nightly-*.yml` feed files on `updates.hexbot.app` during the build and links the files they name, or falls back to the GitHub nightly listing if the feed is unreachable. The same page lists earlier nightlies from `nightlies.json` in the bucket, written by the nightly workflow; until that file exists it lists the current build alone.

Because the page reads the feed at build time, the site must be rebuilt after every release even when no file in `apps/site/` changed. The release workflow does this through the `release-workflow` deploy hook on the `hexbot-site` project, stored as the `SITE_DEPLOY_HOOK_URL` repository secret (`docs/release.md`). A stable release also commits the manifest to `main`, which triggers a production build on its own; the hook covers nightlies.

Smoke check after a deploy: `https://hexbot.app/`, `/docs/`, `/docs/connect/`, `/pair/`, and `/privacy/` all return 200 with the security headers.

## Update server

`updates.hexbot.app` is a Cloudflare R2 bucket with a custom domain, nothing else. The release workflow uploads every package and the electron-updater feed files into it; the desktop app, the download page, and the Homebrew casks all read from it. Layout and one-time setup are in `docs/release.md`. There is no code to deploy.

## Connect

Connect needs Clerk, Neon, Cloudflare, a signing key, and optionally the PostHog key. `apps/connect/README.md` lists every variable and where it comes from. Without them the deployment is a placeholder: every API call returns 401 and the pages say sign-in is unavailable. `GET /api/health` returns `ready: false` until all four backends are the production ones.

Environment variables are set per environment in the Vercel project. Production holds the real accounts. Preview holds nothing today, so a preview of Connect builds and serves pages but rejects every sign-in; to make previews usable, add a Clerk development instance, a Neon branch, and a separate signing key to the Preview environment only. Never give Preview the production Clerk, Neon, or Cloudflare credentials. `CONNECT_BASE_URL` stays unset in Preview because the code falls back to the request origin.

Order of operations for the first real deployment:

1. Move the `hexbot.app` nameservers to Cloudflare (free plan). Recreate the Vercel records there as DNS-only: `hexbot.app` A `76.76.21.21`, `www` and `connect` CNAME `cname.vercel-dns.com`. Confirm the Vercel domains show as verified afterwards.
2. Create a Cloudflare API token with Account: Cloudflare Tunnel: Edit and Zone: DNS: Edit for the zone. Note the account id and zone id.
3. Create a Clerk application with a production instance on `connect.hexbot.app` and add its DNS records in Cloudflare (DNS-only). Enable the sign-in methods you want (email code or password, passkeys, Google, GitHub); the pages use Clerk's components at `/sign-in` and `/sign-up`, so nothing beyond the domain needs configuring.
4. Create a Neon project and run `DATABASE_URL=... pnpm --filter ./apps/connect run migrate`.
5. Generate the signing key: `node apps/connect/scripts/make-signing-key.mjs`.
6. Add every variable to the `hexbot-connect` project for Production, redeploy the current production deployment from the Vercel dashboard, and check `/api/health` says `ready: true`.
7. Register a daemon with `hexbot connect`, open it in a browser from connect.hexbot.app, then sign in from a client-only app on another network.

The daemon and the app default to `https://connect.hexbot.app`. `HEXBOT_CONNECT_URL` (daemon) and the `hexbot.connect.url` local-storage key or `VITE_HEXBOT_CONNECT_URL` (web bundle) override it for a staging instance or a preview.
