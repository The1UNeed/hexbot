import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { makeNativeUpdate } from './make-native-update.mjs'

const run = promisify(execFile)

test('native updater manifests use Rust targets and checksummed relocatable archives', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-native-feed-'))
  try {
    const bundle = join(root, 'bundle'); await mkdir(bundle)
    await writeFile(join(bundle, 'hexbot'), '#!/bin/sh\nexit 0\n')
    await writeFile(join(bundle, 'manifest.json'), JSON.stringify({ version: '1.2.3-nightly.20260924.1', target: 'darwin-arm64' }))
    const result = await makeNativeUpdate(bundle, join(root, 'updates'))
    assert.equal(result.manifest.target, 'macos-aarch64')
    assert.equal(result.manifest.entrypoint, 'hexbot')
    assert.equal(result.manifest.format, 'tar.gz')
    assert.equal(result.manifest.url, `https://updates.hexbot.app/daemon/native/1.2.3-nightly.20260924.1/macos-aarch64/${result.filename}`)
    assert.equal(result.manifest.sha256, createHash('sha256').update(await readFile(join(result.directory, result.filename))).digest('hex'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('release archives the signed app runtime on both macOS targets and the staged runtime on Linux', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
  const step = /- name: Archive the native daemon\n[^\n]*\n        run: \|\n([\s\S]*?)(?=      - uses:)/.exec(workflow)
  assert.ok(step, 'Native archive step missing')
  const script = step[1].replace(/^          /gm, '')
  const root = await mkdtemp(join(tmpdir(), 'hexbot-release-native-'))
  try {
    for (const file of ['make-native-update.mjs', 'native-runtime.mjs', 'native-build.mjs']) {
      await mkdir(join(root, 'scripts/desktop'), { recursive: true })
      await cp(new URL(file, import.meta.url), join(root, 'scripts/desktop', file))
    }
    await mkdir(join(root, 'apps/desktop/src/main/backend'), { recursive: true })
    await cp(new URL('../../apps/desktop/src/main/backend/tools.ts', import.meta.url), join(root, 'apps/desktop/src/main/backend/tools.ts'))
    const staged = join(root, 'apps/desktop/resources/hexbot-native')
    const packaged = join(root, 'apps/desktop/release/mac-arm64/Hexbot [alpha].app/Contents/Resources/hexbot-native')
    for (const [target, runner, expected] of [
      ['darwin-arm64', 'macOS', 'signed'], ['darwin-x64', 'macOS', 'signed'], ['linux-x64', 'Linux', 'unsigned']
    ]) {
      await rm(join(root, 'apps/desktop/release'), { recursive: true, force: true })
      for (const [bundle, signature] of [[staged, 'unsigned'], [packaged.replace('mac-arm64', target === 'darwin-x64' ? 'mac' : 'mac-arm64'), 'signed']]) {
        await mkdir(bundle, { recursive: true })
        await writeFile(join(bundle, 'manifest.json'), JSON.stringify({ version: '1.2.3', target, builtAt: 123, files: Object.fromEntries(['node', 'hexbot-core'].map(file => [file, createHash('sha256').update(`unsigned ${target} ${file}`).digest('hex')])) }))
        for (const file of ['node', 'hexbot-core']) await writeFile(join(bundle, file), `${signature} ${target} ${file}`)
      }
      await run('bash', ['-c', script], { cwd: root, env: { ...process.env, RUNNER_OS: runner } })
      const updateTarget = target.replace('darwin', 'macos').replace('arm64', 'aarch64').replace('x64', 'x86_64')
      const directory = join(root, 'native-updates/daemon/native/1.2.3', updateTarget)
      const archive = join(directory, `hexbot-native-1.2.3-${updateTarget}.tar.gz`)
      const extracted = join(root, `extracted-${target}`)
      await mkdir(extracted)
      await run('tar', ['-xzf', archive, '-C', extracted])
      const archived = JSON.parse(await readFile(join(extracted, 'manifest.json'), 'utf8'))
      for (const file of ['node', 'hexbot-core']) {
        const bytes = await readFile(join(extracted, file))
        assert.equal(bytes.toString(), `${expected} ${target} ${file}`)
        assert.equal(archived.files[file], createHash('sha256').update(bytes).digest('hex'))
      }
      assert.equal(archived.builtAt, 123)
      const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
      assert.equal(manifest.builtAt, 123)
      assert.equal(manifest.sha256, createHash('sha256').update(await readFile(archive)).digest('hex'))
    }
    // macOS must never silently fall back to the unsigned staged runtime.
    await rm(join(root, 'apps/desktop/release'), { recursive: true, force: true })
    await assert.rejects(run('bash', ['-c', script], { cwd: root, env: { ...process.env, RUNNER_OS: 'macOS' } }))
    await cp(staged, packaged, { recursive: true })
    await cp(staged, packaged.replace('Hexbot [alpha].app', 'Other.app'), { recursive: true })
    await assert.rejects(run('bash', ['-c', script], { cwd: root, env: { ...process.env, RUNNER_OS: 'macOS' } }))
  } finally { await rm(root, { recursive: true, force: true }) }
})
