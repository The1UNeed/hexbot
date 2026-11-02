import type { UpdateError } from './update-state'

/** Normalize only Windows feed failures; other platforms keep their existing text. */
export function normalizeUpdateError(
  error: unknown,
  platform: NodeJS.Platform,
  context: 'check' | 'download' | 'install' = 'check'
): string | UpdateError {
  const raw = error instanceof Error ? error.message : String(error)
  if (platform !== 'win32') return raw
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  const detail = `${code} ${raw}`
  // A missing feed only means "nothing published yet" during a check; the
  // same 404 mid-download is a real failure. Version numbers such as
  // 0.404.1 must not look like one, so they are scrubbed first.
  const scrubbed = detail.replace(/\d+(?:\.\d+)+/g, 'version')
  if (
    context === 'check' &&
    (/\b404\b/.test(scrubbed) ||
      /ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|no (?:update )?feed|cannot find (?:latest|nightly|channel)/i.test(
        detail
      ))
  )
    return { message: 'No update is available for this channel yet.', raw }
  if (
    /net::|ERR_(?:INTERNET|NETWORK|CONNECTION|NAME_NOT_RESOLVED|TIMED_OUT)|E(?:CONNRESET|CONNREFUSED|NOTFOUND|AI_AGAIN|TIMEDOUT)|network|fetch failed/i.test(
      detail
    )
  )
    return {
      message: 'Could not reach the update server. Check your connection and try again.',
      raw
    }
  return { message: raw, raw }
}
