import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { readDesktopState, updateDesktopState } from './desktop-state'

vi.mock('electron', () => ({ app: {} }))

describe('desktop state', () => {
  it('keeps every patch when updates overlap', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'hexbot-state-')), 'desktop-state.json')

    await Promise.all([
      updateDesktopState({ height: 600, width: 800 }, file),
      updateDesktopState({ trayExplained: true }, file),
      updateDesktopState({ x: 10, y: 20 }, file)
    ])

    expect(await readDesktopState(file)).toEqual({
      height: 600,
      trayExplained: true,
      width: 800,
      x: 10,
      y: 20
    })
  })
})
