import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { migrateLegacyService } from './service'
import { launchdPlist, systemdUnit } from './service-files'

for (const platform of ['darwin', 'linux'] as const) {
  it(`migrates ${platform} services once, removing the legacy PATH`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'hexbot-service-'))
    const home = join(root, 'home & space')
    const file = join(root, 'service')
    const options = { home, executable: join(home, 'runtime/native-executable'), path: `${home}/bin:/usr/bin`, logDir: join(home, 'logs') }
    const render = platform === 'darwin' ? launchdPlist : systemdUnit
    const calls: string[][] = []
    try {
      await writeFile(file, render({ ...options, executable: join(home, 'runtime/venv/bin/hexbot'), path: `${home}/runtime/venv/bin:${options.path}` }))
      await migrateLegacyService(file, platform, options, async (...args) => { calls.push([args[0], ...args[1]]) })
      expect(await readFile(file, 'utf8')).toBe(render(options))
      const count = calls.length
      await migrateLegacyService(file, platform, options, async () => { throw new Error('must not run twice') })
      expect(calls).toHaveLength(count)
      expect(calls[1]).toContain(platform === 'darwin' ? 'bootout' : 'stop')
      expect(calls.at(-1)).toContain(platform === 'darwin' ? 'bootstrap' : 'start')
      expect(await readFile(join(home, 'runtime/native-transition-pending'), 'utf8')).toBe('remove-shim')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}
it('removes the Python runtime when no service uses it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-legacy-runtime-'))
  const runtime = join(root, 'runtime')
  const options = { home: root, executable: join(runtime, 'native-executable'), path: '/usr/bin', logDir: root }
  const leftovers = ['venv/bin/hexbot', 'src/0.1.4/hexbot/db.py', 'ripgrep-extract/rg', 'ripgrep-14.1.1-aarch64-apple-darwin.tar.gz', 'uv-install.sh']
  const kept = ['native/1.0.0/hexbot', 'tools/edge-tts/bin/edge-tts', 'uv-cache/CACHEDIR.TAG']
  try {
    for (const file of [...leftovers, ...kept]) {
      await mkdir(dirname(join(runtime, file)), { recursive: true })
      await writeFile(join(runtime, file), file)
    }
    // A pending handoff leaves cleanup, and the shim it may keep, to the daemon.
    await writeFile(join(runtime, 'native-transition-pending'), '1')
    await migrateLegacyService(join(root, 'missing.service'), 'darwin', options, async () => { throw new Error('no service calls') })
    expect(existsSync(join(runtime, 'venv/bin/hexbot'))).toBe(true)
    await rm(join(runtime, 'native-transition-pending'))
    await migrateLegacyService(join(root, 'missing.service'), 'darwin', options, async () => { throw new Error('no service calls') })
    for (const file of leftovers) expect(existsSync(join(runtime, file.split('/')[0]!))).toBe(false)
    for (const file of kept) expect(existsSync(join(runtime, file))).toBe(true)
    // The daemon's forwarding script from a service handoff survives until launchd reloads.
    await mkdir(join(runtime, 'venv/bin'), { recursive: true })
    await writeFile(join(runtime, 'venv/bin/hexbot'), '#!/bin/sh\nset -eu\nexec native-executable "$@"\n')
    await migrateLegacyService(join(root, 'missing.service'), 'darwin', options, async () => { throw new Error('no service calls') })
    expect(existsSync(join(runtime, 'venv/bin/hexbot'))).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})
it('a failed service restart restores the old definition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-service-failure-'))
  const options = { home: root, executable: join(root, 'runtime/native-executable'), path: '/usr/bin', logDir: root }
  const file = join(root, 'hexbot.service')
  const old = systemdUnit({ ...options, executable: join(root, 'runtime/venv/bin/hexbot') })
  try {
    await mkdir(dirname(file), { recursive: true }); await writeFile(file, old)
    await expect(migrateLegacyService(file, 'linux', options, async (_command, args) => {
      if (args.includes('start')) throw new Error('start failed')
    })).rejects.toThrow('start failed')
    expect(await readFile(file, 'utf8')).toBe(old)
  } finally { await rm(root, { recursive: true, force: true }) }
})
