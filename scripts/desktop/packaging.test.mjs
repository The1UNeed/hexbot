import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { feedMetadataNames, writeFeedMetadata } from './update-feed-utils.mjs'
import { excludedRoots, includePythonSource } from './python-src-manifest.mjs'
import { updateCask } from './update-cask.mjs'

test('Python source manifest shares root and nested exclusions', () => {
  const root = '/repo'
  assert.equal(excludedRoots.has('apps'), true)
  assert.equal(includePythonSource(root, join(root, 'hexbot', 'serve.py')), true)
  assert.equal(includePythonSource(root, join(root, 'hexbot', '__pycache__', 'serve.pyc')), false)
  assert.equal(includePythonSource(root, join(root, 'docker', 'hexbot', 'context')), false)
})

test('cask updater rewrites version and both architecture hashes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hexbot-cask-'))
  const cask = join(directory, 'hexbot.rb')
  await writeFile(cask, '  version "old"\n  sha256 arm: "old-arm", intel: "old-intel"\n')
  await writeFile(join(directory, 'Hexbot-1.2.3-mac-arm64.dmg'), 'arm')
  await writeFile(join(directory, 'Hexbot-1.2.3-mac-x64.dmg'), 'intel')
  const result = await updateCask(directory, cask)
  const source = await readFile(cask, 'utf8')
  assert.equal(result.version, '1.2.3')
  assert.match(source, /version "1\.2\.3"/)
  assert.match(source, new RegExp(result.hashes.arm64))
  assert.match(source, new RegExp(result.hashes.x64))
})

test('prerelease feeds include beta metadata beside latest metadata', async () => {
  assert.deepEqual(feedMetadataNames('1.2.3-beta.1', 'mac'), ['latest-mac.yml', 'beta-mac.yml'])
  assert.deepEqual(feedMetadataNames('1.2.3', 'linux'), ['latest-linux.yml'])
  const directory = await mkdtemp(join(tmpdir(), 'hexbot-feed-'))
  await writeFeedMetadata(directory, '1.2.3-beta.1', 'mac', 'version: 1.2.3-beta.1\n')
  assert.equal(await readFile(join(directory, 'latest-mac.yml'), 'utf8'), 'version: 1.2.3-beta.1\n')
  assert.equal(await readFile(join(directory, 'beta-mac.yml'), 'utf8'), 'version: 1.2.3-beta.1\n')
})
