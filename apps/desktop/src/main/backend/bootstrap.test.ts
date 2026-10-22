import { expect, it } from 'vitest'
import { performBootstrap, installCodeRuntime, type BootstrapDeps } from './bootstrap'
import { toolAsset } from './tools'

it('rejects a full package missing its native bundle instead of installing a legacy daemon', async () => {
  await expect(performBootstrap({ appIsPackaged: true, resourcesPath: '/missing', exists: () => false }))
    .rejects.toThrow('missing its Hexbot runtime')
})
it('pins every downloaded tool for each supported target', () => {
  for (const tool of ['uv', 'rg', 'fd'] as const) for (const platform of ['darwin', 'linux']) for (const arch of ['arm64', 'x64']) {
    const asset = toolAsset(tool, platform, arch)
    expect(asset.url).toMatch(/^https:\/\/github\.com\/[\w-]+\/[\w-]+\/releases\/download\/v?\d+\.\d+\.\d+\/[\w.-]+\.tar\.gz$/)
    expect(asset.url).toContain(asset.version)
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
  }
  for (const tool of ['rg', 'fd', 'uv'] as const) {
    const asset = toolAsset(tool, 'win32', 'x64')
    expect(asset.url).toMatch(/windows-msvc\.zip$/)
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(asset.member).toMatch(/\.exe$/)
  }
  expect(toolAsset('uv', 'win32', 'x64').member).toBe('uv.exe')
  expect(() => toolAsset('rg', 'win32', 'arm64')).toThrow('Unsupported')
})

it('rejects a bad download checksum before extraction or execution', async () => {
  const { mkdtemp, mkdir, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = await mkdtemp(join(tmpdir(), 'hexbot-uv-'))
  const oldHome = process.env.HEXBOT_HOME
  process.env.HEXBOT_HOME = home
  let ran = false
  try {
    await mkdir(join(home, 'runtime'))
    await expect(installCodeRuntime({ appIsPackaged: true, appVersion: '1.0.0', resourcesPath: home, platform: 'darwin', arch: 'arm64', exists: () => false,
      emit: () => undefined, download: async () => 'wrong', run: async () => { ran = true }
    } as BootstrapDeps)).rejects.toThrow('checksum mismatch')
    expect(ran).toBe(false)
  } finally {
    if (oldHome === undefined) delete process.env.HEXBOT_HOME
    else process.env.HEXBOT_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

it('pins every voice dependency with hashes for managed Python', async () => {
  const { readFile } = await import('node:fs/promises')
  const requirements = await readFile(new URL('../../../../../backend/hexbot-core/assets/edge-tts.requirements.txt', import.meta.url), 'utf8')
  const entries = requirements.split('\n').filter(line => line && !line.startsWith('#'))
  const pins = entries.filter(line => !line.startsWith(' '))
  expect(pins).toContain('edge-tts==7.2.7 \\')
  for (const pin of pins) expect(pin).toMatch(/^[a-z][a-z0-9-]*==[0-9][^ ]* \\$/)
  for (const hash of entries.filter(line => line.startsWith(' ')))
    expect(hash).toMatch(/^ {4}--hash=sha256:[a-f0-9]{64}( \\)?$/)
  for (let index = 0; index < entries.length; index++) {
    if (!entries[index]!.startsWith(' ')) expect(entries[index + 1]).toMatch(/^ {4}--hash=sha256:/)
  }
})

it.runIf(process.platform !== 'win32')('provisions Python and voice in copy mode even when uv is configured to hardlink', async () => {
  const { existsSync } = await import('node:fs')
  const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { dirname, join } = await import('node:path')
  const home = await mkdtemp(join(tmpdir(), 'hexbot uv copy '))
  const before = { home: process.env.HEXBOT_HOME, mode: process.env.UV_LINK_MODE }
  process.env.HEXBOT_HOME = home
  process.env.UV_LINK_MODE = 'hardlink'
  const uv = toolAsset('uv', 'darwin', 'arm64')
  const calls: string[] = []
  try {
    await installCodeRuntime({
      appIsPackaged: true, appVersion: '1.0.0', resourcesPath: home, platform: 'darwin', arch: 'arm64',
      exists: existsSync, emit: () => undefined,
      download: async () => uv.sha256,
      run: async (command, args, options, line) => {
        if (command === 'tar') {
          const extracted = join(args[3]!, uv.member)
          await mkdir(dirname(extracted), { recursive: true }); await writeFile(extracted, 'trusted test uv')
          return
        }
        expect(options?.env?.UV_LINK_MODE).toBe('copy')
        calls.push(args.slice(0, 2).join(' '))
        if (args[0] === 'python' && args[1] === 'find') {
          const python = join(home, 'python/managed/bin/python3.11')
          await mkdir(dirname(python), { recursive: true }); await writeFile(python, 'fixture')
          line?.(python)
        }
        if (args[0] === 'venv') {
          const entry = join(args.at(-1)!, 'bin/edge-tts')
          await mkdir(dirname(entry), { recursive: true }); await writeFile(entry, 'fixture')
        }
      }
    })
    expect(calls).toContain('python install')
    expect(calls).toContain('python find')
    expect(calls).toContain('pip install')
  } finally {
    if (before.home === undefined) delete process.env.HEXBOT_HOME
    else process.env.HEXBOT_HOME = before.home
    if (before.mode === undefined) delete process.env.UV_LINK_MODE
    else process.env.UV_LINK_MODE = before.mode
    await rm(home, { recursive: true, force: true })
  }
})
