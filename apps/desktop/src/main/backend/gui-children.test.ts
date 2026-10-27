import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
const launch = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: launch }))
vi.mock('electron', () => ({ app: { on: () => undefined, isPackaged: true } }))
import { runChild } from './bootstrap'

it('hides GUI bootstrap children and passes the exact selected home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hexbot gui children '))
  const previous = process.env.HEXBOT_HOME
  process.env.HEXBOT_HOME = home
  launch.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
    queueMicrotask(() => { child.emit('exit', 0); child.emit('close', 0) })
    return child
  })
  try {
    await runChild('trusted-node', ['trusted-pi.js'], { env: { USERPROFILE: 'chosen profile' } })
    expect(launch).toHaveBeenCalledWith('trusted-node', ['trusted-pi.js'], {
      cwd: undefined, windowsHide: process.platform === 'win32', env: { USERPROFILE: 'chosen profile', HEXBOT_HOME: home }
    })
  } finally {
    if (previous === undefined) delete process.env.HEXBOT_HOME
    else process.env.HEXBOT_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})
