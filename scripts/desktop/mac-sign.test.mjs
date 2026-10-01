import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import macSign from './mac-sign.cjs'
import afterPack from './after-pack.cjs'

const run = promisify(execFile)

test('custom signing scopes unsigned executable memory to bundled Node', async () => {
  const app = '/build/Hexbot.app'
  let calls = 0
  await macSign.default({
    app, identity: 'certificate hash',
    optionsForFile: () => ({ hardenedRuntime: true, entitlements: 'app.plist', timestamp: true })
  }, {
    platformSpecificBuildOptions: { sign: 'custom-sign.cjs' },
    doSign: async (options, config, identity) => {
      calls++
      assert.equal(config.sign, null)
      assert.equal(identity.name, 'certificate hash')
      for (const file of [app, join(app, 'Contents/Frameworks/Helper.app'), join(app, 'Contents/Resources/hexbot-native/hexbot-core')]) {
        assert.equal(options.optionsForFile(file).entitlements, 'app.plist')
      }
      const node = options.optionsForFile(join(app, 'Contents/Resources/hexbot-native/node'))
      assert.equal(node.hardenedRuntime, true)
      assert.equal(node.timestamp, true)
      assert.match(await readFile(node.entitlements, 'utf8'), /allow-unsigned-executable-memory/)
      assert.doesNotMatch(await readFile(resolve('apps/desktop/entitlements.mac.plist'), 'utf8'), /allow-unsigned-executable-memory/)
    }
  })
  assert.equal(calls, 1)
})

test('ad-hoc Electron bundles launch without hardened library validation', { skip: process.platform !== 'darwin' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-adhoc-app-'))
  const certificate = process.env.CSC_LINK
  const identity = process.env.CSC_NAME
  delete process.env.CSC_LINK
  delete process.env.CSC_NAME
  t.after(async () => {
    if (certificate !== undefined) process.env.CSC_LINK = certificate
    if (identity !== undefined) process.env.CSC_NAME = identity
    await rm(root, { recursive: true, force: true })
  })
  const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
  const electron = require('electron')
  const app = join(root, 'Hexbot.app')
  await cp(resolve(dirname(electron), '../..'), app, { recursive: true, verbatimSymlinks: true })
  await afterPack.default({ electronPlatformName: 'darwin', appOutDir: root, packager: { appInfo: { productFilename: 'Hexbot' } } })
  const details = await run('codesign', ['-dv', app])
  assert.doesNotMatch(details.stderr, /flags=.*\bruntime\b/)
  const result = await run(join(app, 'Contents/MacOS/Electron'), ['-e', 'console.log("app launched")'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  assert.equal(result.stdout.trim(), 'app launched')
})

test('release actions cannot use mutable third-party refs', async () => {
  for (const workflow of ['ci.yml', 'release.yml']) {
    const source = await readFile(new URL(`../../.github/workflows/${workflow}`, import.meta.url), 'utf8')
    for (const [, owner, ref] of source.matchAll(/uses:\s+([^\s/]+)\/[^\s@]+@([^\s]+)/g)) {
      if (owner !== 'actions') assert.match(ref, /^[a-f0-9]{40}$/)
    }
  }
})

test('electron-builder applies the custom entitlements to signed app contents', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-custom-sign-'))
  try {
    const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
    const builderRequire = createRequire(require.resolve('electron-builder'))
    const { MacPackager } = builderRequire('app-builder-lib')
    const app = join(root, 'Hexbot.app')
    await cp(resolve(dirname(require('electron')), '../..'), app, { recursive: true, verbatimSymlinks: true })
    const native = join(app, 'Contents/Resources/hexbot-native')
    await mkdir(native)
    await cp(process.execPath, join(native, 'node'))
    await macSign.default({
      app, platform: 'darwin', identity: '-', identityValidation: false,
      version: require('electron/package.json').version, preAutoEntitlements: false,
      optionsForFile: () => ({ hardenedRuntime: true, entitlements: resolve('apps/desktop/entitlements.mac.plist') })
    }, {
      doSign: MacPackager.prototype.doSign,
      appInfo: { type: 'module' },
      info: { getWorkspaceRoot: async () => root },
      platformSpecificBuildOptions: {}
    })
    for (const [file, unsignedMemory] of [[app, false], [join(native, 'node'), true],
      [join(app, 'Contents/Frameworks/Electron Helper.app'), false]]) {
      const details = await run('codesign', ['-dv', file])
      assert.match(details.stderr, /flags=.*\bruntime\b/)
      const entitlements = await run('codesign', ['-d', '--entitlements', ':-', file])
      assert.equal(/<key>com\.apple\.security\.cs\.allow-unsigned-executable-memory<\/key>\s*<true\s*\/>/.test(entitlements.stdout), unsignedMemory)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('CI gates releases on all Pi tests, macOS Rust tests and staged runtime sessions', async () => {
  const ci = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const release = await readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
  assert.match(ci, /os: \[ubuntu-24\.04, macos-latest\]/)
  assert.match(ci, /node --test \.\.\/pi-runtime\/\*\.test\.mjs/)
  assert.match(ci, /HEXBOT_TEST_PI="\$GITHUB_WORKSPACE\/apps\/desktop\/resources\/hexbot-native\/pi\/hexbot-pi" cargo test .*--test runtime -- --ignored/)
  assert.match(release, /uses: \.\/\.github\/workflows\/ci\.yml/)
  assert.match(release, /HEXBOT_PACKAGED_TEST_DIR=.*node --test scripts\/desktop\/runtime-signing\.test\.mjs/)
})
