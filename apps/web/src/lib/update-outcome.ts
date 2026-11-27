/**
 * What happened to a daemon update, read by its id from
 * `hexbot.update.status` (docs/channels.md, "Trial and rollback").
 */
import type { DaemonUpdateOutcome } from './types'

/** The message for an update that didn't stick, or null while it is open or kept. */
export function outcomeFailure(
  outcome: DaemonUpdateOutcome | null | undefined,
  updateId: null | string | undefined
): null | string {
  if (!outcome || !updateId || outcome.id !== updateId || outcome.status === 'committed') {
    return null
  }

  if (outcome.status === 'rolled-back') {
    const reason = outcome.reason ? ` It ${outcome.reason}.` : ''

    return `The daemon couldn't start ${outcome.to}, so it went back to ${outcome.from}.${reason}`
  }

  if (outcome.status === 'superseded') {
    return "Another version was installed on the daemon's computer during the update."
  }

  return outcome.reason ? `The update failed: ${outcome.reason}` : 'The update failed.'
}
