import { randomUUID } from 'node:crypto'
import { sendUsageEvent, type UsageContext, usageDay, type UsageProperties } from '@hermes/shared'
import { app } from 'electron'
import { desktopStateFile, readDesktopState, updateDesktopState } from './desktop-state'

// Anonymous usage data from the app itself (docs/usage-data.md). Off until the
// user turns it on in the setup guide or Settings, Privacy. The daemon has its
// own switch, because a client-only app may connect to someone else's daemon.

const projectKey = __HEXBOT_POSTHOG_KEY__.trim()
const HOUR = 60 * 60 * 1000

/** `DO_NOT_TRACK` and `HEXBOT_USAGE_DATA=0` win over the setting. */
export function usageRefused(env: NodeJS.ProcessEnv = process.env): boolean {
  const dnt = env.DO_NOT_TRACK?.trim()
  const own = env.HEXBOT_USAGE_DATA?.trim()
  return Boolean(dnt && dnt !== '0' && dnt !== 'false') || own === '0' || own === 'false'
}

/** Whether this build can send usage data at all. */
export const usageAvailable = (key = projectKey): boolean => key.length > 0 && !usageRefused()

export async function readUsageData(file = desktopStateFile()): Promise<boolean> {
  return (await readDesktopState(file)).usageData === true
}

interface Options {
  file?: string
  key?: string
  now?: () => Date
  send?: typeof fetch
}

async function context({ file = desktopStateFile(), key = projectKey }: Options) {
  const state = await readDesktopState(file)
  if (state.usageData !== true || !usageAvailable(key)) return null
  const id = state.usageId ?? randomUUID()
  if (!state.usageId) await updateDesktopState({ usageId: id }, file)
  const usage: UsageContext = {
    arch: process.arch,
    id,
    key,
    platform: process.platform,
    surface: 'desktop',
    version: app.getVersion()
  }
  return { state, usage }
}

export async function captureUsage(
  event: string,
  properties: UsageProperties = {},
  options: Options = {}
) {
  const ready = await context(options)
  if (ready) await sendUsageEvent(ready.usage, event, properties, options.send)
}

/** `app_active` at most once per UTC day, so weekly active installs can be counted. */
export async function sendDailyUsage(options: Options = {}): Promise<void> {
  const ready = await context(options)
  const day = usageDay(options.now?.())
  if (!ready || ready.state.usageDay === day) return
  await updateDesktopState({ usageDay: day }, options.file)
  await sendUsageEvent(
    ready.usage,
    'app_active',
    { channel: __HEXBOT_CHANNEL__, edition: __HEXBOT_EDITION__ },
    options.send
  )
}

/** Turning usage data off forgets the install id; turning it on counts today straight away. */
export async function setUsageData(enabled: boolean, options: Options = {}): Promise<void> {
  await updateDesktopState(
    enabled ? { usageData: true } : { usageData: false, usageDay: undefined, usageId: undefined },
    options.file
  )
  if (enabled) await sendDailyUsage(options)
}

export function startUsageData(): void {
  void sendDailyUsage()
  setInterval(() => void sendDailyUsage(), HOUR).unref()
  // A renderer or helper that dies is the one error the app reports itself;
  // the daemon reports its own. Only Electron's reason label is sent.
  app.on('render-process-gone', (_event, _contents, details) => {
    void captureUsage('app_error', { kind: 'renderer', reason: details.reason })
  })
  app.on('child-process-gone', (_event, details) => {
    void captureUsage('app_error', { kind: details.type, reason: details.reason })
  })
}
