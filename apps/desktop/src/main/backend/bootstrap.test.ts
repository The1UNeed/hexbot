import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { performBootstrap, ripgrepAssetName, type BootstrapStage } from './bootstrap'

let root = ''
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})
describe('bootstrap', () => {
  it('selects pinned ripgrep assets', () => {
    expect(ripgrepAssetName('darwin', 'arm64')).toBe('ripgrep-14.1.1-aarch64-apple-darwin.tar.gz')
    expect(ripgrepAssetName('darwin', 'x64')).toBe('ripgrep-14.1.1-x86_64-apple-darwin.tar.gz')
    expect(ripgrepAssetName('linux', 'x64')).toBe('ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz')
  })
  it('emits stages in install order with child processes mocked', async () => {
    root = await mkdtemp(join(tmpdir(), 'hexbot-desktop-'))
    const oldHome = process.env.HEXBOT_HOME
    process.env.HEXBOT_HOME = join(root, 'home')
    const resources = join(root, 'resources')
    await mkdir(join(resources, 'hexbot-src'), { recursive: true })
    await writeFile(join(resources, 'hexbot-src', 'pyproject.toml'), '')
    const stages: BootstrapStage[] = []
    try {
      await performBootstrap({
        appIsPackaged: true,
        appVersion: '1.0.0',
        resourcesPath: resources,
        emit: event => stages.push(event.stage),
        exists: path => String(path).endsWith('/uv') || String(path).endsWith('/venv'),
        run: async () => undefined,
        download: async () => '',
        platform: 'darwin',
        arch: 'arm64'
      })
    } finally {
      if (oldHome === undefined) delete process.env.HEXBOT_HOME
      else process.env.HEXBOT_HOME = oldHome
    }
    expect(stages.filter((stage, index) => stages[index - 1] !== stage)).toEqual([
      'uv',
      'python',
      'source',
      'venv',
      'dependencies',
      'git',
      'ripgrep',
      'done'
    ])
  })
})
