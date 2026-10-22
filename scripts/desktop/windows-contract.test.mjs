import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { toolAsset } from '../../apps/desktop/src/main/backend/tools.ts'
import { feedMetadataName } from './update-feed-utils.mjs'
import { makeInstallManifest } from './make-install-manifest.mjs'
const exec = promisify(execFile)

test('Windows uses updater wire filenames and distinct NSIS editions without public manifest targets', async t => {
  assert.equal(feedMetadataName('stable', 'win'), 'latest.yml')
  assert.equal(feedMetadataName('nightly', 'win'), 'nightly.yml')
  const root = await mkdtemp(join(tmpdir(), 'hexbot windows feed '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const version = '1.2.3'
  for (const [edition, prefix] of [['full', 'Hexbot'], ['client', 'HexbotClient']]) {
    const out = join(root, edition); await mkdir(out)
    const filename = `${prefix}-${version}-win-x64.exe`
    const bytes = Buffer.from(`${edition} NSIS fixture`)
    await writeFile(join(out, filename), bytes)
    await exec(process.execPath, ['scripts/desktop/make-update-feed.mjs', '--channel', 'nightly', '--version', version, ...(edition === 'client' ? ['--client'] : []), out, join(root, 'updates')])
    const feed = await readFile(join(root, 'updates', edition, 'win/x64/nightly.yml'), 'utf8')
    assert(feed.includes(filename)); assert(feed.includes(createHash('sha512').update(bytes).digest('base64')))
  }
  const options = { channel: 'nightly', version, allowMissing: true }
  const publicManifest = await makeInstallManifest(join(root, 'updates'), options)
  assert(!publicManifest.targets['windows-x86_64'])
  const probe = await makeInstallManifest(join(root, 'updates'), { ...options, windowsProbe: true })
  assert.equal(probe.targets['windows-x86_64'].client.format, 'exe')
  assert.match(probe.experimental, /probe only/)
})

test('Windows tool archives have pinned digests and the actual executable members', () => {
  for (const tool of ['uv', 'rg', 'fd']) {
    const asset = toolAsset(tool, 'win32', 'x64')
    assert.match(asset.url, /windows-msvc\.zip$/)
    assert.match(asset.sha256, /^[a-f0-9]{64}$/)
    assert.equal(asset.member.endsWith(`${tool}.exe`), true)
  }
  assert.equal(toolAsset('uv', 'win32', 'x64').member, 'uv.exe')
})

test('Windows CI keeps the production guard and never publishes disposable probes', async () => {
  const ci = await readFile('.github/workflows/windows-contract.yml', 'utf8')
  for (const line of ci.split('\n').filter(line => line.includes('uses:')))
    assert.match(line, /@[a-f0-9]{40}(?:\s|$)/)
  assert(!/secrets\.|contents:\s*write|release.yml|--publish\s+always/.test(ci.replace(/^#.*$/gm, '')))
  assert(ci.includes('check-windows-unsupported.mjs'))
  assert(ci.includes('prepare-windows-security.mjs'))
  assert(ci.includes('--test windows_contract -- --ignored'))
  assert(ci.includes('--test windows_launchers --test windows_contract'))
  assert(ci.includes('--test windows_security --no-run --message-format=json'))
  assert(ci.includes('windows-security-standard-user.ps1'))
  assert(!ci.includes('--example windows_contract'))
  assert(ci.includes('windows-update-restart.mjs'))
  assert(ci.includes('windows-installed-app-smoke.mjs'))
  assert(ci.includes('windows-paths.test.ts'))
  assert(ci.includes('--test windows_pi --test windows_shutdown -- --ignored'))
  assert(!ci.slice(ci.indexOf('  native-runtime:')).includes('upload-artifact'))
  const release = await readFile('.github/workflows/release.yml', 'utf8')
  assert(!release.includes('windows-latest'))
})

test('Tauri Windows resource icon reproduces the existing installer art', async () => {
  const { installerIco } = await import('./make-installer-windows-icon.mjs')
  const base = 'apps/installer/src-tauri/'
  const png = await readFile(`${base}icons/128x128@2x.png`)
  const ico = await readFile(`${base}icons/icon.ico`)
  assert.deepEqual(ico, installerIco(png))
  assert.equal(ico.readUInt16LE(2), 1)
  assert.equal(ico.readUInt16LE(4), 1)
  assert.equal(ico.readUInt32LE(18), 22)
  assert.deepEqual(ico.subarray(22), png)
  assert(JSON.parse(await readFile(`${base}tauri.conf.json`, 'utf8')).bundle.icon.includes('icons/icon.ico'))
})

test('Windows packages own their app before the outer installer commits a receipt', async t => {
  const afterPack = (await import('./after-pack.cjs')).default.default
  const root = await mkdtemp(join(tmpdir(), 'hexbot packaged ownership '))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const id of ['app.hexbot.client', 'app.hexbot.desktop.nightly']) {
    await afterPack({ electronPlatformName: 'win32', appOutDir: root, packager: { appInfo: { id } } })
    assert.deepEqual(JSON.parse(await readFile(join(root, '.hexbot-app.json'), 'utf8')), { appId: id })
  }
})
