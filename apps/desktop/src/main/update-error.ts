import type { UpdateError } from './update-state'

/** Normalize only Windows feed failures; other platforms keep their existing text. */
export function normalizeUpdateError(
  error: unknown,
  platform: NodeJS.Platform
): string | UpdateError {
  const raw = error instanceof Error ? error.message : String(error)
  if (platform !== 'win32') return raw
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  const detail = `${code} ${raw}`
  if (
    /\b404\b|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|no (?:update )?feed|cannot find (?:latest|nightly|channel)/i.test(
      detail
    )
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
