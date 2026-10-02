import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { makeNativeUpdate } from './make-native-update.mjs'
const run = promisify(execFile)

async function verifyMinimumMacOS(bundle, plist) {
  const floor = (await run('plutil', ['-extract', 'LSMinimumSystemVersion', 'raw', plist])).stdout.trim()
  const parts = version => version.split('.').map(Number)
  for (const name of ['node', 'hexbot-core', 'bin/rg', 'bin/fd']) {
    const { stdout } = await run('vtool', ['-show-build', join(bundle, name)])
    // LC_BUILD_VERSION reports minos; older x64 binaries carry LC_VERSION_MIN_MACOSX.
    const minimum = /minos (\d+(?:\.\d+)*)/.exec(stdout)?.[1] ?? /LC_VERSION_MIN_MACOSX[\s\S]*?version (\d+(?:\.\d+)*)/.exec(stdout)?.[1]
    assert(minimum, `${name} has no macOS version`)
    const [major, minor = 0] = parts(minimum), [floorMajor, floorMinor = 0] = parts(floor)
    assert(major < floorMajor || (major === floorMajor && minor <= floorMinor), `${name} needs macOS ${minimum}; the app runs on ${floor}`)
  }
}

test('bundled Node and daemon run under the macOS hardened runtime', {
  skip: process.platform !== 'darwin' || !process.env.HEXBOT_NATIVE_TEST_BUNDLE
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-signed-'))
  const bundle = process.env.HEXBOT_NATIVE_TEST_BUNDLE
  try {
    for (const name of ['node', 'hexbot-core']) {
      const binary = join(root, name)
      await cp(join(bundle, name), binary)
      await run('codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', resolve(`apps/desktop/entitlements.${name === 'node' ? 'node' : 'mac'}.plist`), binary])
      await run('codesign', ['--verify', '--strict', binary])
    }
    const env = { ...process.env, HEXBOT_HOME: root }
    const node = await run(join(root, 'node'), ['-e', 'let n=0; for(let i=0;i<1e6;i++) n+=i; console.log(n)'], { env })
    assert.equal(node.stdout.trim(), '499999500000')
    const pi = await run(join(root, 'node'), [join(bundle, 'pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js'), '--version'], { env })
    const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'))
    assert.equal(pi.stdout.trim(), manifest.piVersion)
    const daemon = await run(join(root, 'hexbot-core'), ['version'], { env })
    assert.match(daemon.stdout, /^\d+\.\d+\.\d+/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('bundled executables run on every macOS the app installs on', {
  skip: process.platform !== 'darwin' || !process.env.HEXBOT_NATIVE_TEST_BUNDLE
}, async () => {
  await verifyMinimumMacOS(process.env.HEXBOT_NATIVE_TEST_BUNDLE,
    resolve('apps/desktop/node_modules/electron/dist/Electron.app/Contents/Info.plist'))
})

test('packaged macOS apps launch with their shipped signatures and entitlements', {
  skip: process.platform !== 'darwin' || !process.env.HEXBOT_PACKAGED_TEST_DIR
}, async () => {
  const release = process.env.HEXBOT_PACKAGED_TEST_DIR
  const apps = []
  for (const directory of await readdir(release)) {
    const path = join(release, directory)
    if (!directory.startsWith('mac') || !(await stat(path)).isDirectory()) continue
    for (const file of await readdir(path)) if (file.endsWith('.app')) apps.push(join(path, file))
  }
  assert.ok(apps.length, 'No packaged macOS app found')
  const home = await mkdtemp(join(tmpdir(), 'hexbot-packaged-signing-'))
  const env = { ...process.env, HEXBOT_HOME: home }
  try {
    for (const app of apps) {
      await run('codesign', ['--verify', '--deep', '--strict', app])
      const details = await run('codesign', ['-dv', app])
      const developerId = !details.stderr.includes('Signature=adhoc')
      if (process.env.CSC_LINK || process.env.CSC_NAME) assert.ok(developerId, 'Developer ID signature missing')
      const inspect = async (file, unsignedMemory = false) => {
        await run('codesign', ['--verify', '--strict', file])
        const signature = await run('codesign', ['-dv', file])
        if (developerId) {
          assert.match(signature.stderr, /flags=.*\bruntime\b/)
          assert.match(signature.stderr, /TeamIdentifier=(?!not set)\S+/)
          const entitlements = await run('codesign', ['-d', '--entitlements', ':-', file])
          assert.equal(/<key>com\.apple\.security\.cs\.allow-unsigned-executable-memory<\/key>\s*<true\s*\/>/.test(entitlements.stdout), unsignedMemory, file)
        }
      }
      await inspect(app)
      for (const helper of await readdir(join(app, 'Contents/Frameworks'))) {
        if (helper.endsWith('.app')) await inspect(join(app, 'Contents/Frameworks', helper))
      }
      const executable = await run('plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', join(app, 'Contents/Info.plist')])
      await run(join(app, 'Contents/MacOS', executable.stdout.trim()), ['-e', '0'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' } })
      const bundle = join(app, 'Contents/Resources/hexbot-native')
      const hasRuntime = Boolean((await stat(bundle).catch(() => null))?.isDirectory())
      if (process.env.HEXBOT_PACKAGED_TEST_EDITION)
        assert.equal(hasRuntime, process.env.HEXBOT_PACKAGED_TEST_EDITION === 'full', app)
      if (!hasRuntime) continue
      await verifyMinimumMacOS(bundle, join(app, 'Contents/Info.plist'))
      for (const tool of ['rg', 'fd']) await inspect(join(bundle, 'bin', tool))
      await inspect(join(bundle, 'node'), true)
      await inspect(join(bundle, 'hexbot-core'))
      const node = await run(join(bundle, 'node'), ['-e', 'let n=0; for(let i=0;i<1e6;i++) n+=i; console.log(n)'], { env })
      assert.equal(node.stdout.trim(), '499999500000')
      const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'))
      const pi = await run(join(bundle, 'pi/hexbot-pi'), ['--version'], { env })
      assert.equal(pi.stdout.trim(), manifest.piVersion)
      const daemon = await run(join(bundle, 'hexbot'), ['version'], { env })
      assert.equal(daemon.stdout.trim(), manifest.version)
      const update = await makeNativeUpdate(bundle, join(home, 'updates'))
      const extracted = await mkdtemp(join(home, 'self-update-'))
      await run('tar', ['-xzf', join(update.directory, update.filename), '-C', extracted])
      for (const file of ['node', 'hexbot-core']) {
        assert.deepEqual(await readFile(join(extracted, file)), await readFile(join(bundle, file)))
        await inspect(join(extracted, file), file === 'node')
      }
    }
  } finally { await rm(home, { recursive: true, force: true }) }
})
