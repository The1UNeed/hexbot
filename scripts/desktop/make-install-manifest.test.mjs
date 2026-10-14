import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { MIN_INSTALLER, makeInstallManifest } from './make-install-manifest.mjs'
import { appId } from './release-version.mjs'
import { feedMetadataName } from './update-feed-utils.mjs'

const hash = (contents, algorithm, encoding) => createHash(algorithm).update(contents).digest(encoding)
const targets = [['macos-aarch64', 'mac', 'arm64'], ['macos-x86_64', 'mac', 'x64'], ['linux-x86_64', 'linux', 'x64']]

async function fixture(t, channel = 'stable', version = '0.1.5-alpha.1', baseUrl = 'https://updates.hexbot.app') {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-install-manifest-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (path, contents) => {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), contents)
  }
  for (const [target, os, arch] of targets) {
    for (const edition of ['full', 'client']) {
      const prefix = edition === 'full' ? 'Hexbot' : 'HexbotClient'
      const name = os === 'mac' ? `${prefix}-${version}-mac-${arch}.zip` : `${prefix}-${version}-linux-x86_64.AppImage`
      const path = `${edition}/${os}/${arch}`
      const content = `${edition} ${target}`
      await put(`${path}/${name}`, content)
      const files = os === 'mac' ? `  - url: '${name.replace('.zip', '.dmg')}'\n    sha512: unused\n    size: 3\n` : ''
      if (os === 'mac') await put(`${path}/${name.replace('.zip', '.dmg')}`, 'dmg')
      await put(`${path}/${feedMetadataName(channel, os)}`, `version: '${version}'\nfiles:\n${files}  - url: "${name}"\n    sha512: ${hash(content, 'sha512', 'base64')}\n    size: ${content.length}\npath: ${name}\n`)
    }
    const path = `daemon/native/${version}/${target}`
    const filename = `hexbot-native-${version}-${target}.tar.gz`
    await put(`${path}/${filename}`, target)
    await put(`${path}/manifest.json`, JSON.stringify({ version, target, format: 'tar.gz', size: target.length,
      sha256: hash(target, 'sha256', 'hex'), url: `${baseUrl}/${path}/${filename}` }))
    await put(`install/${version}/hexbot-install-${version}-${target}`, target)
    await put(`install/${version}/HexbotInstaller-${version}-${os === 'mac' ? `mac-${arch}.dmg` : 'linux-x86_64.AppImage'}`, target)
  }
  return { root, options: { channel, version } }
}

test('install manifests cover every option, target and track with verified metadata', async t => {
  for (const [channel, version] of [['stable', '0.1.5-alpha.1'], ['nightly', '0.1.5-nightly.20261003.42']]) {
    const { root, options } = await fixture(t, channel, version, 'https://mirror.example/updates')
    const manifest = await makeInstallManifest(root, { ...options, baseUrl: 'https://mirror.example/updates/' })
    assert.deepEqual(Object.keys(manifest), ['schema', 'channel', 'version', 'minInstaller', 'targets'])
    assert.equal(manifest.schema, 1)
    assert.equal(manifest.channel, channel)
    assert.equal(manifest.minInstaller, MIN_INSTALLER)
    assert.deepEqual(Object.keys(manifest.targets), targets.map(([target]) => target))
    for (const [target, os] of targets) {
      const entry = manifest.targets[target]
      assert.deepEqual(Object.keys(entry), ['full', 'client', 'headless', 'installer', 'installerApp'])
      assert.equal(entry.full.format, os === 'mac' ? 'zip' : 'AppImage')
      assert.equal(entry.client.format, entry.full.format)
      assert.equal(entry.full.productName, channel === 'stable' ? 'Hexbot [alpha]' : 'Hexbot Nightly')
      assert.equal(entry.client.productName, channel === 'stable' ? 'Hexbot Client [alpha]' : 'Hexbot Client Nightly')
      assert.equal(entry.full.appId, channel === 'stable' ? 'app.hexbot.desktop' : 'app.hexbot.desktop.nightly')
      assert.equal(entry.client.appId, channel === 'stable' ? 'app.hexbot.client' : 'app.hexbot.client.nightly')
      assert.equal(entry.headless.format, 'tar.gz')
      assert.equal(entry.headless.manifest, `daemon/native/${version}/${target}/manifest.json`)
      assert.equal(entry.installer.sha256, hash(target, 'sha256', 'hex'))
      assert.equal(entry.installer.size, target.length)
      assert.ok(entry.installerApp.url.endsWith(os === 'mac' ? '.dmg' : '.AppImage'))
      for (const option of Object.values(entry)) {
        assert.ok(!option.path.startsWith('/') && !option.path.includes('://'))
        assert.equal(option.url, `https://mirror.example/updates/${option.path}`)
      }
    }
    assert.deepEqual(JSON.parse(await readFile(join(root, `install/${channel}.json`), 'utf8')), manifest)
    assert.equal(await readFile(join(root, `install/${channel}.txt`), 'utf8'), targets.map(([target]) => {
      const installer = manifest.targets[target].installer
      return `${target} ${installer.sha256} ${installer.url}\n`
    }).join(''))
  }
  assert.equal(appId('dev'), 'app.hexbot.desktop.dev')
  assert.throws(() => appId('other'), /Unknown channel/)
})

test('missing options require --allow-missing, including the later windowed installer', async t => {
  const { root, options } = await fixture(t)
  await rm(join(root, `install/${options.version}/HexbotInstaller-${options.version}-mac-arm64.dmg`))
  await assert.rejects(makeInstallManifest(root, options), /Missing install artifact:.*HexbotInstaller/)
  const manifest = await makeInstallManifest(root, { ...options, allowMissing: true })
  assert.equal(manifest.targets['macos-aarch64'].installerApp, undefined)
  assert.ok(manifest.targets['macos-aarch64'].installer)
  await rm(join(root, 'client/linux/x64'), { recursive: true })
  assert.equal((await makeInstallManifest(root, { ...options, allowMissing: true })).targets['linux-x86_64'].client, undefined)
})

test('a missing referenced archive fails even with --allow-missing', async t => {
  const { root, options } = await fixture(t)
  await rm(join(root, `full/mac/arm64/Hexbot-${options.version}-mac-arm64.zip`))
  await assert.rejects(makeInstallManifest(root, { ...options, allowMissing: true }), /Referenced file is missing/)
})

test('a missing native archive fails even with --allow-missing', async t => {
  const { root, options } = await fixture(t)
  await rm(join(root, `daemon/native/${options.version}/macos-aarch64/hexbot-native-${options.version}-macos-aarch64.tar.gz`))
  await assert.rejects(makeInstallManifest(root, { ...options, allowMissing: true }), /Referenced file is missing/)
})

test('corrupt payloads and stale versions cannot be published', async t => {
  const { root, options } = await fixture(t)
  const path = join(root, `full/mac/arm64/Hexbot-${options.version}-mac-arm64.zip`)
  await writeFile(path, 'x'.repeat('full macos-aarch64'.length))
  await assert.rejects(makeInstallManifest(root, options), /checksum mismatch/)
  await writeFile(path, 'full macos-aarch64')
  await assert.rejects(makeInstallManifest(root, { ...options, version: '1.0.0' }), /Wrong feed version/)
  await assert.rejects(makeInstallManifest(root, { ...options, channel: 'dev' }), /Unknown channel/)
  await assert.rejects(makeInstallManifest(root, { ...options, version: '../bad' }), /Invalid install version/)
})

test('the CLI parses options around the update root and rejects typos', async t => {
  const { root, options } = await fixture(t)
  const script = new URL('./make-install-manifest.mjs', import.meta.url)
  const run = promisify(execFile)
  await run(process.execPath, [script.pathname, '--channel', options.channel, '--version', options.version, root, '--base-url', 'https://mirror.example'])
  assert.ok((await readFile(join(root, 'install/stable.txt'), 'utf8')).includes('https://mirror.example/install/'))
  await assert.rejects(run(process.execPath, [script.pathname, root, '--typo']), /Unexpected argument/)
})

test('native metadata must include the base URL path prefix', async t => {
  const { root, options } = await fixture(t)
  await assert.rejects(makeInstallManifest(root, { ...options, baseUrl: 'https://mirror.example/updates/' }), /Invalid native archive URL/)
})

test('new manifests satisfy the published installer absolute-URL validation', async t => {
  const { root, options } = await fixture(t)
  const manifest = await makeInstallManifest(root, options)
  // origin/main validate_origins parses each artifact.url without a base,
  // then compares its origin. Older clients ignore the extra path field.
  const base = new URL('https://updates.hexbot.app')
  for (const entries of Object.values(manifest.targets)) {
    for (const artifact of Object.values(entries)) {
      const url = new URL(artifact.url)
      assert.equal(url.protocol, 'https:')
      assert.equal(url.origin, base.origin)
      assert.equal(artifact.url, `${base.origin}/${artifact.path}`)
      assert.equal(new URL(artifact.path, 'https://mirror.example/updates/').href,
        `https://mirror.example/updates/${artifact.path}`)
    }
  }
})

test('native path takes precedence when preparing a mirror install manifest', async t => {
  const { root, options } = await fixture(t)
  for (const [target] of targets) {
    const path = join(root, `daemon/native/${options.version}/${target}/manifest.json`)
    const metadata = JSON.parse(await readFile(path, 'utf8'))
    metadata.path = metadata.url.replace('https://updates.hexbot.app/', '')
    await writeFile(path, JSON.stringify(metadata))
  }
  const canonical = await makeInstallManifest(root, options)
  const mirror = await makeInstallManifest(root, { ...options, baseUrl: 'https://mirror.example/updates/' })
  for (const [target, entries] of Object.entries(canonical.targets)) {
    for (const [option, artifact] of Object.entries(entries)) {
      assert.equal(mirror.targets[target][option].path, artifact.path)
      assert.equal(mirror.targets[target][option].url, `https://mirror.example/updates/${artifact.path}`)
    }
  }
})
