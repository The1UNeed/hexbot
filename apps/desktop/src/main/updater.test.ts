import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readUpdateChannel } from './desktop-state'

describe('readUpdateChannel', () => {
  it('defaults to stable when state is absent or invalid', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hexbot-updater-'))
    expect(await readUpdateChannel(join(directory, 'missing.json'))).toBe('stable')
    await writeFile(join(directory, 'state.json'), JSON.stringify({ updateChannel: 'nightly' }))
    expect(await readUpdateChannel(join(directory, 'state.json'))).toBe('stable')
  })

  it('selects beta from desktop state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hexbot-updater-'))
    const file = join(directory, 'state.json')
    await writeFile(file, JSON.stringify({ updateChannel: 'beta' }))
    expect(await readUpdateChannel(file)).toBe('beta')
  })
})
