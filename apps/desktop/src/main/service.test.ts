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
    const options = { home, executable: join(home, 'runtime/native-executable'), path: `${home}/bin:/usr/bin`, node: 'node', logDir: join(home, 'logs') }
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
it('a failed service restart restores the old definition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-service-failure-'))
  const options = { home: root, executable: join(root, 'runtime/native-executable'), path: '/usr/bin', node: 'node', logDir: root }
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
