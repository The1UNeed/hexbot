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

test('Windows CI cannot publish or bypass the daemon platform guard', async () => {
  const ci = await readFile('.github/workflows/windows-contract.yml', 'utf8')
  for (const line of ci.split('\n').filter(line => line.includes('uses:')))
    assert.match(line, /@[a-f0-9]{40}(?:\s|$)/)
  assert(!/secrets\.|contents:\s*write|release.yml|--publish\s+always/.test(ci.replace(/^#.*$/gm, '')))
  assert(ci.includes('Native daemon compile gate'))
  const release = await readFile('.github/workflows/release.yml', 'utf8')
  assert(!release.includes('windows-latest'))
})
