# Usage data

Anonymous product counts from the apps and the daemon, sent to the same
PostHog project as hexbot.app and Connect. The public list of events is
`apps/site/src/pages/docs/usage-data.md` (hexbot.app/docs/usage-data); the
legal text is the "The apps and the daemon" section of
`apps/site/src/pages/privacy.astro`. Change all three in the same pull
request when an event or a property changes.

## Rules

- **Off until the user says yes.** Every surface starts off and sends nothing
  before its switch is on. A pre-ticked switch is not consent. The setup
  guide asks once (`UsageStep` in `apps/web/src/routes/onboarding.tsx`, the
  phone's first screen); Settings, Privacy changes it later.
- **One switch per install.** The desktop app, each daemon, and each phone
  decide on their own, because a client may connect to someone else's
  daemon. In the full package the setup step sets the app and its daemon
  together. Bots cannot change `usage_data`: it is not in the bot settings
  allowlist (`SETTINGS` in `backend/hexbot-core/src/runtime_primary.rs`).
- **Anonymous.** A random install ID, made when usage data is turned on and
  deleted when it is turned off, never the daemon's `install_id` or a Connect
  account. Every event sets `$process_person_profile: false` and
  `$geoip_disable: true`.
- **Counts and labels only.** No text, names, paths, addresses, keys, or error
  messages. Errors are reported by type or number.
- **No key, no data.** The public project key is baked in at build time, so
  source and dev builds can never send. `DO_NOT_TRACK=1` or
  `HEXBOT_USAGE_DATA=0` turns it off on a computer whatever the switch says.

## Where it lives

| Surface | Code | Switch stored in | Key from |
| --- | --- | --- | --- |
| Daemon | `backend/hexbot-core/src/usage.rs` | `usage_data` setting; ID and last day in `<HEXBOT_HOME>/usage.json` | `HEXBOT_POSTHOG_KEY` at `cargo build` |
| Desktop app | `apps/desktop/src/main/usage-data.ts` | `usageData`, `usageId`, `usageDay` in `desktop-state.json` | `HEXBOT_POSTHOG_KEY` at `electron-vite build` |
| Phone app | `apps/mobile/src/core/usage.ts` | `hexbot.usage` in AsyncStorage | `EXPO_PUBLIC_POSTHOG_KEY` in the `production` profile of `apps/mobile/eas.json` |
| Event shape | `apps/shared/src/usage-data.ts` | | |

The daemon counts RPCs in `Server::call` (`usage::rpc`) and sends
`daemon_active` from an hourly check that sends at most once per UTC day.
The desktop app and the phone send `app_active` the same way.

`release.yml` passes the repository variable `HEXBOT_POSTHOG_KEY` to the
package build, which compiles both the app and the daemon. Set it to the
project key (the same `phc_` key as `PUBLIC_POSTHOG_KEY` on the site). With
the variable unset, a release builds and sends nothing.

## Adding an event

1. Add it where it happens, through `capture`/`captureUsage`, with only
   counts and fixed labels.
2. Add a row to the public table on hexbot.app/docs/usage-data.
3. If it holds a new kind of data, update the privacy policy and its date.
4. Answer the App Store and Google Play privacy questions again if the new
   event changes them (`apps/mobile/README.md`).
