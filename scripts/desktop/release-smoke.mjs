// Run the release-only scripts the way .github/workflows/release.yml runs
// them, against synthetic packages, so a broken script fails in CI and not on
// tag day (T3 Code keeps the same check as scripts/release-smoke.ts).
//
//   node scripts/desktop/release-smoke.mjs
//
// Covers: release-version.mjs for both channels, set-version.mjs, the
// make-update-feed.mjs CLI for both editions and both channels sharing one
// feed root, make-install-manifest.mjs, and finalize-release.mjs (website
// manifest and casks). Everything
// happens in a temporary directory; the repository is not modified.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { finalizeRelease } from './finalize-release.mjs'
import { MIN_INSTALLER } from './make-install-manifest.mjs'
import { setVersion } from './set-version.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const scripts = join(repositoryRoot, 'scripts/desktop')
const run = promisify(execFile)
const sha512 = value => createHash('sha512').update(value).digest('base64')
const parseOutputs = stdout =>
  Object.fromEntries(
    stdout
      .trim()
      .split('\n')
      .map(line => line.split(/=(.*)/s).slice(0, 2))
  )

const packageVersion = JSON.parse(
  await readFile(join(repositoryRoot, 'apps/desktop/package.json'), 'utf8')
).version
const work = await mkdtemp(join(tmpdir(), 'hexbot-release-smoke-'))

try {
  // preflight: resolve the channel and version
  const stable = parseOutputs(
    (
      await run(process.execPath, [
        join(scripts, 'release-version.mjs'),
        '--channel',
        'stable',
        '--ref',
        `refs/tags/v${packageVersion}`
      ])
    ).stdout
  )
  assert.equal(stable.version, packageVersion)
  assert.equal(stable.tag, `v${packageVersion}`)
  const nightly = parseOutputs(
    (
      await run(process.execPath, [
        join(scripts, 'release-version.mjs'),
        '--channel',
        'nightly',
        '--run-number',
        '7'
      ])
    ).stdout
  )
  assert.match(nightly.version, /-nightly\.\d{8}\.7$/)
  assert.equal(nightly.prerelease, 'true')
  console.log(`release-version: stable ${stable.version}, nightly ${nightly.version}`)

  // build: write the version into the app and the daemon (on a copy)
  const versioned = join(work, 'versioned')
  await mkdir(join(versioned, 'apps/desktop'), { recursive: true })
  await cp(
    join(repositoryRoot, 'apps/desktop/package.json'),
    join(versioned, 'apps/desktop/package.json')
  )
  await setVersion(nightly.version, versioned)
  assert.equal(
    JSON.parse(await readFile(join(versioned, 'apps/desktop/package.json'), 'utf8')).version,
    nightly.version
  )
  console.log('set-version: app and daemon updated')

  // publish: the update feed, both editions and both channels in one tree
  const feedRoot = join(work, 'updates')
  const artifacts = {}
  for (const [channel, version] of [
    ['stable', stable.version],
    ['nightly', nightly.version]
  ]) {
    for (const [prefix, edition, flag] of [
      ['Hexbot', 'full', []],
      ['HexbotClient', 'client', ['--client']]
    ]) {
      const output = join(work, `builder-${channel}-${edition}`)
      await mkdir(output, { recursive: true })
      const files = {}
      for (const name of [
        `${prefix}-${version}-mac-arm64.zip`,
        `${prefix}-${version}-mac-arm64.dmg`,
        `${prefix}-${version}-mac-x64.zip`,
        `${prefix}-${version}-mac-x64.dmg`,
        `${prefix}-${version}-linux-x86_64.AppImage`,
        `${prefix}-${version}-linux-amd64.deb`
      ]) {
        files[name] = `${channel} ${edition} ${name}`
        await writeFile(join(output, name), files[name])
      }
      const appImage = `${prefix}-${version}-linux-x86_64.AppImage`
      await writeFile(
        join(output, 'latest-linux.yml'),
        [
          `version: ${version}`,
          'files:',
          `  - url: ${appImage}`,
          `    sha512: ${sha512(files[appImage])}`,
          `    size: ${files[appImage].length}`,
          `path: ${appImage}`,
          `sha512: ${sha512(files[appImage])}`,
          `releaseDate: '${new Date().toISOString()}'`,
          ''
        ].join('\n')
      )
      await run(process.execPath, [
        join(scripts, 'make-update-feed.mjs'),
        '--channel',
        channel,
        '--version',
        version,
        ...flag,
        output,
        feedRoot
      ])
      artifacts[`${channel}-${edition}`] = { prefix, version, edition, files, output }
    }
  }
  for (const { prefix, version, edition, files } of Object.values(artifacts)) {
    const feed = version.includes('-nightly.') ? 'nightly' : 'latest'
    for (const arch of ['arm64', 'x64']) {
      const zip = `${prefix}-${version}-mac-${arch}.zip`
      const manifest = await readFile(
        join(feedRoot, edition, 'mac', arch, `${feed}-mac.yml`),
        'utf8'
      )
      assert.match(manifest, new RegExp(`^version: ${version.replaceAll('.', '\\.')}$`, 'm'))
      assert.match(manifest, new RegExp(`^path: ${zip.replaceAll('.', '\\.')}$`, 'm'))
      assert.ok(manifest.includes(sha512(files[zip])), `${feed}-mac.yml carries the zip sha512`)
      await readFile(join(feedRoot, edition, 'mac', arch, zip))
      await readFile(join(feedRoot, edition, 'mac', arch, `${prefix}-${version}-mac-${arch}.dmg`))
    }
    const linux = await readFile(join(feedRoot, edition, 'linux/x64', `${feed}-linux.yml`), 'utf8')
    assert.match(linux, new RegExp(`^version: ${version.replaceAll('.', '\\.')}$`, 'm'))
    await readFile(join(feedRoot, edition, 'linux/x64', `${prefix}-${version}-linux-x86_64.AppImage`))
    await readFile(join(feedRoot, edition, 'linux/x64', `${prefix}-${version}-linux-amd64.deb`))
  }
  // Both channels wrote into the same directories without clobbering each other.
  await readFile(join(feedRoot, 'full/mac/arm64/latest-mac.yml'))
  await readFile(join(feedRoot, 'full/mac/arm64/nightly-mac.yml'))
  console.log('make-update-feed: full and client, stable and nightly, one tree')

  for (const [channel, version] of [['stable', stable.version], ['nightly', nightly.version]]) {
    for (const [target, app] of [
      ['macos-aarch64', 'mac-arm64.dmg'], ['macos-x86_64', 'mac-x64.dmg'], ['linux-x86_64', 'linux-x86_64.AppImage']
    ]) {
      const native = join(feedRoot, 'daemon/native', version, target)
      const install = join(feedRoot, 'install', version)
      await mkdir(native, { recursive: true })
      await mkdir(install, { recursive: true })
      const name = `hexbot-native-${version}-${target}.tar.gz`
      await writeFile(join(native, name), target)
      await writeFile(join(native, 'manifest.json'), JSON.stringify({
        version, target, format: 'tar.gz', size: target.length,
        sha256: createHash('sha256').update(target).digest('hex'),
        url: `https://updates.hexbot.app/daemon/native/${version}/${target}/${name}`
      }))
      await writeFile(join(install, `hexbot-install-${version}-${target}`), target)
      await writeFile(join(install, `HexbotInstaller-${version}-${app}`), target)
    }
    await run(process.execPath, [join(scripts, 'make-install-manifest.mjs'), '--channel', channel, '--version', version, feedRoot])
    const manifest = JSON.parse(await readFile(join(feedRoot, 'install', `${channel}.json`), 'utf8'))
    assert.equal(manifest.version, version)
    assert.equal(manifest.minInstaller, MIN_INSTALLER)
    assert.equal(Object.keys(manifest.targets).length, 3)
    for (const entry of Object.values(manifest.targets)) assert.equal(Object.keys(entry).length, 5)
    assert.equal((await readFile(join(feedRoot, 'install', `${channel}.txt`), 'utf8')).trim().split('\n').length, 3)
  }
  console.log('make-install-manifest: every target and option, stable and nightly')

  // finalize: website manifest and casks (on a copy)
  const site = join(work, 'site')
  await mkdir(join(site, 'apps/site/public/downloads'), { recursive: true })
  await mkdir(join(site, 'packaging/homebrew'), { recursive: true })
  await cp(
    join(repositoryRoot, 'apps/site/public/downloads/manifest.json'),
    join(site, 'apps/site/public/downloads/manifest.json')
  )
  await cp(join(repositoryRoot, 'packaging/homebrew'), join(site, 'packaging/homebrew'), {
    recursive: true
  })
  const result = await finalizeRelease(
    stable.version,
    artifacts['stable-full'].output,
    artifacts['stable-client'].output,
    site
  )
  const manifest = JSON.parse(
    await readFile(join(site, 'apps/site/public/downloads/manifest.json'), 'utf8')
  )
  assert.equal(manifest.published, true)
  assert.equal(manifest.version, stable.version)
  assert.equal(manifest.mac.arm64, `Hexbot-${stable.version}-mac-arm64.dmg`)
  assert.equal(manifest.client.linux.deb, `HexbotClient-${stable.version}-linux-amd64.deb`)
  for (const [cask, hashes] of [
    ['hexbot.rb', result.full.hashes],
    ['hexbot-client.rb', result.client.hashes]
  ]) {
    const source = await readFile(join(site, 'packaging/homebrew', cask), 'utf8')
    assert.match(source, new RegExp(`version "${stable.version.replaceAll('.', '\\.')}"`))
    assert.ok(source.includes(hashes.arm64) && source.includes(hashes.x64), `${cask} hashes`)
  }
  console.log('finalize-release: manifest published, both casks updated')
  console.log(`Release smoke passed for ${stable.version}`)
} finally {
  await rm(work, { recursive: true, force: true })
}
