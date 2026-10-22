import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { makeUpdateFeed } from './make-update-feed.mjs'

const version = '0.1.5-alpha.1'

async function tree() {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-update-feed-'))
  const output = join(root, 'output')
  const feed = join(root, 'feed')
  await mkdir(output)
  return { root, output, feed }
}

test('windows is optional, a lone exe publishes latest-win.yml, and an empty directory fails', async () => {
  const empty = await tree()
  try {
    await assert.rejects(makeUpdateFeed({ outputDirectory: empty.output, feedRoot: empty.feed, version }), /No update artifacts/)
    const zip = `Hexbot-${version}-mac-arm64.zip`
    await writeFile(join(empty.output, zip), 'mac zip')
    await makeUpdateFeed({ outputDirectory: empty.output, feedRoot: empty.feed, version, releaseDate: '2026-10-20T00:00:00.000Z' })
    assert.match(await readFile(join(empty.feed, 'mac/arm64/latest-mac.yml'), 'utf8'), /version: 0\.1\.5-alpha\.1/)
    await assert.rejects(readFile(join(empty.feed, 'win/x64/latest-win.yml')), { code: 'ENOENT' })

    const only = await tree()
    try {
      const exe = `Hexbot-${version}-windows-x64.exe`
      const bytes = Buffer.from('windows exe')
      await writeFile(join(only.output, exe), bytes)
      await makeUpdateFeed({ outputDirectory: only.output, feedRoot: only.feed, version, releaseDate: '2026-10-20T00:00:00.000Z' })
      const yml = await readFile(join(only.feed, 'win/x64/latest-win.yml'), 'utf8')
      const sha512 = createHash('sha512').update(bytes).digest('base64')
      assert.ok(yml.includes(`url: ${exe}`))
      assert.ok(yml.includes(`sha512: ${sha512}`))
      assert.ok(yml.includes(`size: ${bytes.length}`))
      assert.deepEqual(await readFile(join(only.feed, 'win/x64', exe)), bytes)
    } finally { await rm(only.root, { recursive: true, force: true }) }
  } finally { await rm(empty.root, { recursive: true, force: true }) }
})
