import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { publishPdfSources } from './publish-pdf-sources.mjs'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hexbot-pdf-source-publication-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const target of ['macos-aarch64', 'macos-x86_64']) {
    const path = `daemon/native/1.2.3/${target}`
    await mkdir(join(directory, path), { recursive: true })
    const bytes = Buffer.from(`source companion ${target}`)
    const file = `pdf-sources-1.2.3-${target}.tar.gz`
    const pdfSources = { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      url: `https://updates.hexbot.app/${path}/${file}` }
    await writeFile(join(directory, path, file), bytes)
    await writeFile(join(directory, path, 'manifest.json'), JSON.stringify({ version: '1.2.3', target, pdfSources }))
  }
  return directory
}

test('source-first publication verifies both local archives and their public availability/size', async t => {
  const directory = await fixture(t)
  const events = []
  const archives = await publishPdfSources(directory, '1.2.3', 'hexbot-updates', {
    run: async (command, args) => { assert.equal(command, 'aws'); events.push(['upload', args[3]]) },
    fetch: async (url, options) => {
      assert.equal(options.redirect, 'error')
      events.push([options.method.toLowerCase(), url])
      const bytes = Buffer.from(`source companion ${url.includes('aarch64') ? 'macos-aarch64' : 'macos-x86_64'}`)
      return new Response(options.method === 'HEAD' ? null : bytes, { headers: { 'content-length': String(bytes.length) } })
    }
  })
  assert.equal(archives.length, 2)
  assert.deepEqual(events.map(item => item[0]), ['upload', 'head', 'get', 'upload', 'head', 'get'])
  assert(events.filter(item => item[0] === 'upload').every(item => item[1].startsWith('s3://hexbot-updates/daemon/native/1.2.3/')))
})

test('missing public sources and changed local companions fail publication', async t => {
  const directory = await fixture(t)
  let uploads = 0
  await assert.rejects(publishPdfSources(directory, '1.2.3', 'hexbot-updates', {
    run: async () => { uploads++ }, fetch: async () => new Response(null, { status: 404 }), wait: async () => {}
  }), /public PDF source companion is unavailable/)
  assert.equal(uploads, 1)
  const path = join(directory, 'daemon/native/1.2.3/macos-x86_64')
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'))
  await writeFile(join(path, manifest.pdfSources.file), 'changed')
  uploads = 0
  await assert.rejects(publishPdfSources(directory, '1.2.3', 'hexbot-updates', {
    run: async () => { uploads++ }
  }), /complete and verified/)
  assert.equal(uploads, 0)
})

test('same-sized wrong public bytes fail their declared SHA before binaries can be published', async t => {
  const directory = await fixture(t)
  let gets = 0
  await assert.rejects(publishPdfSources(directory, '1.2.3', 'hexbot-updates', {
    run: async () => {},
    fetch: async (url, options) => {
      const bytes = Buffer.from(`source companion ${url.includes('aarch64') ? 'macos-aarch64' : 'macos-x86_64'}`)
      if (options.method === 'GET') gets++
      return new Response(options.method === 'HEAD' ? null : Buffer.alloc(bytes.length), { headers: { 'content-length': String(bytes.length) } })
    }
  }), /checksum does not match/)
  assert.equal(gets, 1)
})
