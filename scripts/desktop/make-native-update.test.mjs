import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { makeNativeUpdate } from './make-native-update.mjs'

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
