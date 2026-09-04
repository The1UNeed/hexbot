// Hexbot ships as two packages built from one code base:
// - full: the desktop app plus the daemon runtime (Python source, bootstrap,
//   launch-at-login service).
// - client: the desktop app alone; it can only connect to a daemon elsewhere.
// The edition is fixed at build time by HEXBOT_EDITION (see
// electron.vite.config.ts) so a client package never tries to run a daemon.
export type Edition = 'full' | 'client'

export function parseEdition(value: string | undefined): Edition {
  return value === 'client' ? 'client' : 'full'
}

export const edition: Edition = parseEdition(import.meta.env.HEXBOT_EDITION)
export const hasRuntime = edition === 'full'

export function requireRuntime(action: string): void {
  if (!hasRuntime)
    throw new Error(
      `${action} needs the full Hexbot package. This is the client-only app; it can only connect to a daemon running elsewhere.`
    )
}
