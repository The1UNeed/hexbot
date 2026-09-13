import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { prepareDevElectron } from './electron-launcher.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

test('macOS dev launcher has its own signed identity and stays unpackaged', {
  skip: process.platform !== 'darwin', timeout: 60_000
}, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "hexbot dev's launcher-"))
  const desktop = join(temporary, 'apps/desktop')
  const require = createRequire(join(root, 'apps/desktop/package.json'))
  const sourcePlist = resolve(require('electron'), '../../Info.plist')
  const original = await readFile(sourcePlist)
  const edition = process.env.HEXBOT_EDITION
  try {
    await mkdir(join(desktop, 'build'), { recursive: true })
    await writeFile(join(desktop, 'package.json'), '{}')
    await symlink(join(root, 'apps/desktop/node_modules'), join(desktop, 'node_modules'))
    await copyFile(join(root, 'apps/desktop/build/icon-dev.icns'), join(desktop, 'build/icon-dev.icns'))
    const entry = join(temporary, 'probe.cjs')
    await writeFile(entry, `const { app } = require('electron');
app.whenReady().then(() => { console.log(JSON.stringify({ packaged: app.isPackaged })); app.quit() })`)
    const env = { ...process.env, HEXBOT_HOME: temporary }
    delete env.ELECTRON_RUN_AS_NODE
    for (const client of [false, true]) {
      process.env.HEXBOT_EDITION = client ? 'client' : 'full'
      const binary = await prepareDevElectron(temporary)
      const bundle = resolve(binary, '../../..')
      const plist = JSON.parse(execFileSync('plutil', [
        '-convert', 'json', '-o', '-', join(bundle, 'Contents/Info.plist')
      ], { encoding: 'utf8' }))
      assert.equal(plist.CFBundleDisplayName, client ? 'Hexbot Client (dev)' : 'Hexbot (dev)')
      assert.match(plist.CFBundleIdentifier, new RegExp(`^app.hexbot.${client ? 'client' : 'desktop'}\\.dev\\.`))
      assert.equal(plist.CFBundleExecutable, 'Electron')
      assert.deepEqual(
        await readFile(join(bundle, 'Contents/Resources', plist.CFBundleIconFile)),
        await readFile(join(desktop, 'build/icon-dev.icns'))
      )
      const framework = join(bundle, 'Contents/Frameworks/Electron Framework.framework')
      assert.equal(await readlink(join(framework, 'Resources')), 'Versions/Current/Resources')
      execFileSync('codesign', ['--verify', '--deep', '--strict', bundle])
      const output = execFileSync(binary, [entry], { env, encoding: 'utf8', timeout: 15_000 })
      assert.equal(JSON.parse(output.trim()).packaged, false)
      const before = (await stat(binary)).mtimeMs
      assert.equal(await prepareDevElectron(temporary), binary)
      assert.equal((await stat(binary)).mtimeMs, before)
    }
    assert.deepEqual(await readFile(sourcePlist), original)
  } finally {
    if (edition === undefined) delete process.env.HEXBOT_EDITION
    else process.env.HEXBOT_EDITION = edition
    await rm(temporary, { recursive: true, force: true })
  }
})
