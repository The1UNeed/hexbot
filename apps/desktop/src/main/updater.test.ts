import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultUpdateChannel, isNightlyVersion, readUpdateChannel } from './desktop-state'

describe('readUpdateChannel', () => {
  it('falls back when state is absent or names a channel that no longer exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hexbot-updater-'))
    expect(await readUpdateChannel('stable', join(directory, 'missing.json'))).toBe('stable')
    expect(await readUpdateChannel('nightly', join(directory, 'missing.json'))).toBe('nightly')
    await writeFile(join(directory, 'state.json'), JSON.stringify({ updateChannel: 'beta' }))
    expect(await readUpdateChannel('stable', join(directory, 'state.json'))).toBe('stable')
  })

  it('reads a saved channel', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hexbot-updater-'))
    const file = join(directory, 'state.json')
    await writeFile(file, JSON.stringify({ updateChannel: 'nightly' }))
    expect(await readUpdateChannel('stable', file)).toBe('nightly')
  })
})

describe('defaultUpdateChannel', () => {
  it('derives the track from the build version', () => {
    expect(isNightlyVersion('0.1.5-nightly.20260906.42')).toBe(true)
    expect(isNightlyVersion('0.1.5-alpha.1')).toBe(false)
    expect(defaultUpdateChannel('0.1.5-nightly.20260906.42')).toBe('nightly')
    expect(defaultUpdateChannel('0.1.5-alpha.1')).toBe('stable')
    expect(defaultUpdateChannel('1.0.0')).toBe('stable')
  })
})
