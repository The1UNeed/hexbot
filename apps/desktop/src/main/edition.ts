// Hexbot ships as two packages built from one code base:
// - full: the desktop app plus the daemon runtime (Python source, bootstrap,
//   launch-at-login service).
// - client: the desktop app alone; it can only connect to a daemon elsewhere.
// The edition is fixed at build time by HEXBOT_EDITION, which
// electron.vite.config.ts bakes into __HEXBOT_EDITION__, so a client package
// never tries to run a daemon. edition.build.test.ts checks the baked value.
export type Edition = 'full' | 'client'

export const edition: Edition = __HEXBOT_EDITION__ === 'client' ? 'client' : 'full'
export const hasRuntime = edition === 'full'

/** The build's app id, as `appId` in scripts/desktop/release-version.mjs names it. */
export function appIdFor(channel: string, client: boolean): string {
  const base = client ? 'app.hexbot.client' : 'app.hexbot.desktop'
  return channel === 'stable' ? base : `${base}.${channel}`
}
// A bundle built without the channel, such as a test fixture, counts as dev.
export const appId = appIdFor(
  typeof __HEXBOT_CHANNEL__ === 'string' ? __HEXBOT_CHANNEL__ : 'dev',
  edition === 'client'
)

export function requireRuntime(action: string): void {
  if (!hasRuntime)
    throw new Error(
      `${action} needs the full Hexbot package. This is the client-only app; it can only connect to a daemon running elsewhere.`
    )
}
