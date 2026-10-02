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
  expect(() => toolAsset('rg', 'win32', 'x64')).toThrow('Unsupported')
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
  const requirements = await readFile(new URL('./edge-tts.requirements.txt', import.meta.url), 'utf8')
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
