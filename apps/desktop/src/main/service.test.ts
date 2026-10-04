import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { hexbotHome } from './backend/paths'
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

it('finds an SSH-installed launchd service in the user domain', async () => {
  const { serviceStatus } = await import('./service')
  const root = await mkdtemp(join(tmpdir(), 'hexbot-launchd-status-'))
  const file = join(root, 'daemon.plist')
  const calls: string[][] = []
  try {
    await writeFile(file, launchdPlist({ home: hexbotHome(), executable: '/fixture/hexbot', path: '/usr/bin', logDir: '/fixture/logs' }))
    const status = await serviceStatus(file, 'darwin', async (command, args) => {
      calls.push([command, ...args])
      if (args[1]?.startsWith('gui/')) throw new Error('No GUI session')
      return { stdout: '\tstate = running\n' }
    })
    expect(status).toEqual({ installed: true, running: true })
    expect(calls).toEqual([
      ['launchctl', 'print', `gui/${process.getuid!()}/app.hexbot.daemon`],
      ['launchctl', 'print', `user/${process.getuid!()}/app.hexbot.daemon`]
    ])
    expect(await serviceStatus(file, 'darwin', async () => { throw new Error('Stopped') }))
      .toEqual({ installed: true, running: false })
    for (const stdout of ['state = waiting', 'state = not running', 'last state = running', '']) {
      expect(await serviceStatus(file, 'darwin', async () => ({ stdout })))
        .toEqual({ installed: true, running: false })
    }
    await rm(file)
    expect(await serviceStatus(file, 'darwin', async () => { throw new Error('Missing') }))
      .toEqual({ installed: false, running: false })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('unloads both launchd domains before removing the service file', async () => {
  const { uninstallService } = await import('./service')
  const root = await mkdtemp(join(tmpdir(), 'hexbot-launchd-uninstall-'))
  const file = join(root, 'daemon.plist')
  try {
    for (const loaded of ['gui', 'user', 'neither']) {
      await writeFile(file, 'service')
      const calls: string[][] = []
      await uninstallService(file, 'darwin', async (command, args) => {
        expect(existsSync(file)).toBe(true)
        calls.push([command, ...args])
        if (args[0] === 'bootout' && !args[1]?.startsWith(`${loaded}/`)) throw new Error('Not loaded')
      })
      expect(calls.slice(0, 2)).toEqual([
        ['launchctl', 'bootout', `gui/${process.getuid!()}`, file],
        ['launchctl', 'bootout', `user/${process.getuid!()}`, file]
      ])
      expect(calls).toHaveLength(loaded === 'neither' ? 3 : 2)
      if (loaded === 'neither') expect(calls[2]).toEqual(['launchctl', 'unload', '-w', file])
      expect(existsSync(file)).toBe(false)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each(['gui', 'user'])('ignores a loaded %s service belonging to another home', async domain => {
  const { serviceStatus } = await import('./service')
  const root = await mkdtemp(join(tmpdir(), 'hexbot-foreign-service-'))
  const file = join(root, 'daemon.plist')
  try {
    await writeFile(file, launchdPlist({ home: root, executable: join(root, 'hexbot'), path: '/usr/bin', logDir: root }))
    expect(await serviceStatus(file, 'darwin', async (_command, args) => {
      if (!args[1]?.startsWith(`${domain}/`)) throw new Error('not loaded')
    })).toEqual({ installed: false, running: false })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('only reports the Linux service for this home, decoding systemd escapes', async () => {
  const { serviceStatus } = await import('./service')
  const root = await mkdtemp(join(tmpdir(), 'hexbot-systemd-status-'))
  const file = join(root, 'hexbot.service')
  const home = join(root, 'home %n "quoted" \\ path')
  const run = vi.fn(async () => undefined)
  vi.stubEnv('HEXBOT_HOME', home)
  const unit = systemdUnit({ home, executable: join(home, 'hexbot'), path: '/usr/bin', logDir: home })
  try {
    for (const content of ['', unit.replace('HEXBOT_HOME=', 'OTHER_HOME='),
      systemdUnit({ home: root, executable: '/other/hexbot', path: '/usr/bin', logDir: root }),
      unit + `Environment=HEXBOT_HOME="${root}"\n`,
      unit + `Environment=HEXBOT_HOME=${root}\n`]) {
      await writeFile(file, content)
      expect(await serviceStatus(file, 'linux', run)).toEqual({ installed: false, running: false })
    }
    await rm(file)
    expect(await serviceStatus(file, 'linux', run)).toEqual({ installed: false, running: false })
    expect(run).not.toHaveBeenCalled()
    await writeFile(file, unit)
    expect(await serviceStatus(file, 'linux', run)).toEqual({ installed: true, running: true })
    expect(run).toHaveBeenCalledWith('systemctl', ['--user', 'is-active', 'hexbot'])
    expect(await serviceStatus(file, 'linux', async () => { throw new Error('Stopped') }))
      .toEqual({ installed: true, running: false })
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})
