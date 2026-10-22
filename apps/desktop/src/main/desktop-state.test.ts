import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readDesktopState, updateDesktopState } from './desktop-state'

vi.mock('electron', () => ({ app: {} }))
const directories: string[] = []
async function stateFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'hexbot-state-'))
  directories.push(directory)
  return join(directory, 'desktop-state.json')
}
afterEach(() =>
  Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
)

describe('desktop state', () => {
  it('keeps every patch when settings, the notice, and bounds overlap', async () => {
    const file = await stateFile()
    await Promise.all([
      updateDesktopState({ height: 600, width: 800 }, file),
      updateDesktopState({ backgroundExplained: true }, file),
      updateDesktopState({ crashReports: false, updateChannel: 'nightly' }, file),
      updateDesktopState({ x: 10, y: 20, width: 1000 }, file)
    ])
    expect(await readDesktopState(file)).toEqual({
      backgroundExplained: true,
      crashReports: false,
      height: 600,
      updateChannel: 'nightly',
      width: 1000,
      x: 10,
      y: 20
    })
  })

  it('recovers after a failed write without blocking another file', async () => {
    const blocked = await stateFile()
    await writeFile(blocked, 'a file cannot be a parent directory')
    const file = join(blocked, 'child.json')
    await expect(updateDesktopState({ width: 800 }, file)).rejects.toThrow()
    const other = await stateFile()
    await updateDesktopState({ height: 600 }, other)
    expect(await readDesktopState(other)).toEqual({ height: 600 })
    await rm(blocked)
    await updateDesktopState({ width: 1000 }, file)
    expect(await readDesktopState(file)).toEqual({ width: 1000 })
  })
})
