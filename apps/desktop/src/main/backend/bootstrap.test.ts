import { expect, it } from 'vitest'
import { performBootstrap, installCodeRuntime, type BootstrapDeps } from './bootstrap'
import { uvAsset, UV_VERSION } from './uv'

it('rejects a full package missing its native bundle instead of installing a legacy daemon', async () => {
  await expect(performBootstrap({ appIsPackaged: true, resourcesPath: '/missing', exists: () => false }))
    .rejects.toThrow('missing its Hexbot runtime')
})
it('pins code runtime installers for each supported target', () => {
  for (const platform of ['darwin', 'linux']) for (const arch of ['arm64', 'x64']) {
    const asset = uvAsset(platform, arch)
    expect(asset.url).toContain(`/download/${UV_VERSION}/`)
    expect(asset.url).toMatch(/\.tar\.gz$/)
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
  }
  expect(() => uvAsset('win32', 'x64')).toThrow('Unsupported')
})

it('rejects a bad installer checksum before extraction or execution', async () => {
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
