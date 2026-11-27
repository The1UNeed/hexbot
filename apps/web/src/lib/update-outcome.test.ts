import { describe, expect, it } from 'vitest'

import type { DaemonUpdateOutcome } from './types'
import { outcomeFailure } from './update-outcome'

const outcome = (
  status: DaemonUpdateOutcome['status'],
  reason: null | string = null
): DaemonUpdateOutcome => ({
  at: '2026-11-27T00:00:00Z',
  from: '0.1.6',
  id: 'u1',
  reason,
  status,
  to: '0.1.7'
})

describe('outcomeFailure', () => {
  it('says nothing for another update, an open one, or a kept one', () => {
    expect(outcomeFailure(null, 'u1')).toBeNull()
    expect(outcomeFailure(outcome('rolled-back'), 'u2')).toBeNull()
    expect(outcomeFailure(outcome('rolled-back'), null)).toBeNull()
    expect(outcomeFailure(outcome('committed'), 'u1')).toBeNull()
  })

  it('says the daemon went back to the version it had', () => {
    expect(outcomeFailure(outcome('rolled-back', 'crashed while starting'), 'u1')).toBe(
      "The daemon couldn't start 0.1.7, so it went back to 0.1.6. It crashed while starting."
    )
  })

  it('reports a failure before the switch and an install in between', () => {
    expect(outcomeFailure(outcome('failed', 'the download changed on disk'), 'u1')).toBe(
      'The update failed: the download changed on disk'
    )
    expect(outcomeFailure(outcome('superseded'), 'u1')).toContain('Another version')
  })
})
