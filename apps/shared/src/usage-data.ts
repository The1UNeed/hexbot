// Anonymous usage data from the apps (docs/usage-data.md). The daemon sends
// its own from backend/hexbot-core/src/usage.rs in the same shape. Callers
// decide whether the user said yes; this module only builds and posts events.
//
// Every event is anonymous: a random install id, no person profile, and no
// location looked up from the address. Properties are counts, versions, and
// fixed labels, never names, paths, or text.

export const USAGE_CAPTURE_URL = 'https://us.i.posthog.com/i/v0/e/'
export const USAGE_DOCS_URL = 'https://hexbot.app/docs/usage-data/'

export type UsageSurface = 'desktop' | 'mobile'
export type UsageProperties = Record<string, boolean | null | number | string>

export interface UsageContext {
  /** PostHog project key baked in at build time; empty in source and dev builds. */
  key: string
  /** Random install id, made when the user turns usage data on and deleted when they turn it off. */
  id: string
  surface: UsageSurface
  version: string
  /** `process.platform` or React Native's `Platform.OS`. */
  platform: string
  arch?: string
}

const OS: Record<string, string> = {
  android: 'Android',
  darwin: 'Mac OS X',
  ios: 'iOS',
  linux: 'Linux',
  win32: 'Windows'
}

/** One event as PostHog's capture endpoint takes it. */
export function usageEvent(context: UsageContext, event: string, properties: UsageProperties = {}) {
  return {
    api_key: context.key,
    event,
    distinct_id: context.id,
    properties: {
      ...properties,
      surface: context.surface,
      version: context.version,
      $os: OS[context.platform] ?? context.platform,
      ...(context.arch ? { arch: context.arch } : {}),
      $lib: `hexbot-${context.surface}`,
      $process_person_profile: false,
      $geoip_disable: true
    }
  }
}

/** Posts one event. Never throws: usage data must not break the app. */
export async function sendUsageEvent(
  context: UsageContext,
  event: string,
  properties: UsageProperties = {},
  send: typeof fetch = fetch
): Promise<void> {
  if (!context.key.trim()) {
    return
  }

  try {
    await send(USAGE_CAPTURE_URL, {
      body: JSON.stringify(usageEvent(context, event, properties)),
      headers: { 'content-type': 'application/json' },
      method: 'POST'
    })
  } catch {
    // Offline or blocked: the event is dropped, never retried with more detail.
  }
}

/** `YYYY-MM-DD` in UTC, the day an `*_active` event counts for. */
export const usageDay = (now = new Date()) => now.toISOString().slice(0, 10)
