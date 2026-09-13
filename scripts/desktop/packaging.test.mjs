import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { downloadsManifest, finalizeRelease } from './finalize-release.mjs'
import { nightlyBase, productName, resolveRelease } from './release-version.mjs'
import { setVersion } from './set-version.mjs'
import { feedMetadataName, writeFeedMetadata } from './update-feed-utils.mjs'
import { excludedRoots, includePythonSource } from './python-src-manifest.mjs'
import { updateCask } from './update-cask.mjs'
import { iconOptions, parseBuildArgs } from './build-config.mjs'

test('default dev packaging preserves the platform and builder flags', () => {
  assert.deepEqual(parseBuildArgs(['--mac', '--arm64', '--dir']), {
    client: false, channel: 'dev', builderArgs: ['--mac', '--arm64', '--dir']
  })
  assert.deepEqual(parseBuildArgs(['--client', '--linux', '--channel', 'nightly', '--x64']), {
    client: true, channel: 'nightly', builderArgs: ['--linux', '--x64']
  })
  assert.throws(() => parseBuildArgs(['--mac', '--channel']), /Unknown channel/)
})

test('only dev packages select the custom icon, with and without Icon Composer', () => {
  assert.deepEqual(iconOptions('dev', true), [
    '-c.mac.icon=../../icon-dev.icon', '-c.linux.icon=resources/icon-dev.png'
  ])
  assert.deepEqual(iconOptions('dev', false), [
    '-c.mac.icon=build/icon-dev.icns', '-c.linux.icon=resources/icon-dev.png'
  ])
  for (const channel of ['stable', 'nightly']) {
    assert.deepEqual(iconOptions(channel, true), ['-c.mac.icon=build/Hexbot.icon'])
    assert.deepEqual(iconOptions(channel, false), [])
  }
})

test('Python source manifest shares root and nested exclusions', () => {
  const root = '/repo'
  assert.equal(excludedRoots.has('apps'), true)
  assert.equal(includePythonSource(root, join(root, 'hexbot', 'serve.py')), true)
  assert.equal(includePythonSource(root, join(root, 'hexbot', '__pycache__', 'serve.pyc')), false)
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

test('cask updater accepts the client package prefix', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hexbot-cask-client-'))
  const cask = join(directory, 'hexbot-client.rb')
  await writeFile(cask, '  version "old"\n  sha256 arm: "old-arm", intel: "old-intel"\n')
  await writeFile(join(directory, 'HexbotClient-1.2.3-mac-arm64.dmg'), 'arm')
  await writeFile(join(directory, 'HexbotClient-1.2.3-mac-x64.dmg'), 'intel')
  await writeFile(join(directory, 'Hexbot-9.9.9-mac-arm64.dmg'), 'full')
  const result = await updateCask(directory, cask, undefined, 'HexbotClient')
  assert.equal(result.version, '1.2.3')
  assert.match(await readFile(cask, 'utf8'), /version "1\.2\.3"/)
})

test('feed metadata is named after the channel', async () => {
  assert.equal(feedMetadataName('stable', 'mac'), 'latest-mac.yml')
  assert.equal(feedMetadataName('nightly', 'linux'), 'nightly-linux.yml')
  assert.throws(() => feedMetadataName('beta', 'mac'), /Unknown channel/)
  const directory = await mkdtemp(join(tmpdir(), 'hexbot-feed-'))
  await writeFeedMetadata(directory, 'nightly', 'mac', 'version: 1.2.3-nightly.20260906.1\n')
  assert.equal(
    await readFile(join(directory, 'nightly-mac.yml'), 'utf8'),
    'version: 1.2.3-nightly.20260906.1\n'
  )
})

test('stable releases come from a matching v* tag', () => {
  const full = resolveRelease({
    channel: 'stable',
    packageVersion: '1.2.3',
    ref: 'refs/tags/v1.2.3'
  })
  assert.deepEqual(full, {
    channel: 'stable',
    version: '1.2.3',
    tag: 'v1.2.3',
    prerelease: false,
    latest: true
  })
  const alpha = resolveRelease({
    channel: 'stable',
    packageVersion: '0.1.5-alpha.1',
    ref: 'refs/tags/v0.1.5-alpha.1'
  })
  assert.equal(alpha.prerelease, true)
  assert.equal(alpha.latest, false)
  assert.throws(
    () =>
      resolveRelease({
        channel: 'stable',
        packageVersion: '0.1.5-alpha.2',
        ref: 'refs/tags/v0.1.5-alpha.1'
      }),
    /does not match/
  )
  assert.throws(
    () =>
      resolveRelease({
        channel: 'stable',
        packageVersion: '0.1.5-nightly.20260906.1',
        ref: 'refs/tags/v0.1.5-nightly.20260906.1'
      }),
    /nightly/
  )
})

test('nightly versions sort above the release they lead to', () => {
  assert.equal(nightlyBase('0.1.5'), '0.1.6')
  assert.equal(nightlyBase('0.1.5-alpha.1'), '0.1.5')
  const nightly = resolveRelease({
    channel: 'nightly',
    packageVersion: '0.1.5-alpha.1',
    date: new Date('2026-09-06T09:00:00Z'),
    runNumber: 42
  })
  assert.deepEqual(nightly, {
    channel: 'nightly',
    version: '0.1.5-nightly.20260906.42',
    tag: 'v0.1.5-nightly.20260906.42',
    prerelease: true,
    latest: false
  })
  assert.throws(() => resolveRelease({ channel: 'nightly', packageVersion: '0.1.5' }), /run number/)
  assert.throws(
    () => resolveRelease({ channel: 'beta', packageVersion: '0.1.5' }),
    /Unknown channel/
  )
})

test('product names carry the channel and keep [alpha] before 1.0', () => {
  assert.equal(productName('stable', '0.1.5-alpha.1'), 'Hexbot [alpha]')
  assert.equal(productName('stable', '0.1.5-alpha.1', true), 'Hexbot Client [alpha]')
  assert.equal(productName('stable', '1.0.0'), 'Hexbot')
  assert.equal(productName('nightly', '0.1.5-nightly.20260906.1'), 'Hexbot Nightly')
  assert.equal(productName('dev', '0.1.5-alpha.1'), 'Hexbot (dev)')
  assert.equal(productName('dev', '0.1.5-alpha.1', true), 'Hexbot Client (dev)')
})

test('set-version writes the app and daemon versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-version-'))
  await mkdir(join(root, 'apps/desktop'), { recursive: true })
  await mkdir(join(root, 'hexbot'), { recursive: true })
  await writeFile(join(root, 'apps/desktop/package.json'), '{\n  "version": "0.0.0"\n}\n')
  await writeFile(join(root, 'hexbot/__init__.py'), '"""Hexbot."""\n\n__version__ = "0.0.0"\n')
  await setVersion('0.1.5-nightly.20260906.42', root)
  assert.equal(
    JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8')).version,
    '0.1.5-nightly.20260906.42'
  )
  assert.match(
    await readFile(join(root, 'hexbot/__init__.py'), 'utf8'),
    /__version__ = "0\.1\.5-nightly\.20260906\.42"/
  )
  await assert.rejects(setVersion('not a version', root), /SemVer/)
})

test('finalize-release names the artifacts on the website and in the casks', async () => {
  assert.equal(downloadsManifest('0.1.6').client.linux.deb, 'HexbotClient-0.1.6-linux-x64.deb')
  const root = await mkdtemp(join(tmpdir(), 'hexbot-finalize-'))
  await mkdir(join(root, 'apps/site/public/downloads'), { recursive: true })
  await mkdir(join(root, 'packaging/homebrew'), { recursive: true })
  await writeFile(
    join(root, 'packaging/homebrew/hexbot.rb'),
    '  version "old"\n  sha256 arm: "a", intel: "b"\n'
  )
  await writeFile(
    join(root, 'packaging/homebrew/hexbot-client.rb'),
    '  version "old"\n  sha256 arm: "a", intel: "b"\n'
  )
  const full = join(root, 'full')
  const client = join(root, 'client')
  await mkdir(full)
  await mkdir(client)
  for (const arch of ['arm64', 'x64']) {
    await writeFile(join(full, `Hexbot-0.1.6-mac-${arch}.dmg`), arch)
    await writeFile(join(client, `HexbotClient-0.1.6-mac-${arch}.dmg`), arch)
  }
  await finalizeRelease('0.1.6', full, client, root)
  const manifest = JSON.parse(
    await readFile(join(root, 'apps/site/public/downloads/manifest.json'), 'utf8')
  )
  assert.equal(manifest.published, true)
  assert.equal(manifest.mac.arm64, 'Hexbot-0.1.6-mac-arm64.dmg')
  assert.match(
    await readFile(join(root, 'packaging/homebrew/hexbot-client.rb'), 'utf8'),
    /version "0\.1\.6"/
  )
})
