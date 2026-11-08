// Publish and confirm source companions before advertising their binaries.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { pdfFileHash, pdfSourceArchiveRecord } from './pdf-runtime.mjs'
const execute = promisify(execFile)

export async function publishPdfSources(directory, version, bucket, {
  run = execute, fetch = globalThis.fetch,
  wait = ms => new Promise(done => setTimeout(done, ms))
} = {}) {
  if (!/^[a-z0-9][a-z0-9.-]+$/.test(bucket ?? '')) throw new Error('PDF source publication requires the configured R2 bucket')
  const sources = []
  for (const target of ['macos-aarch64', 'macos-x86_64']) {
    const path = `daemon/native/${version}/${target}`
    const manifest = JSON.parse(await readFile(join(directory, path, 'manifest.json'), 'utf8'))
    if (manifest.version !== version || manifest.target !== target) throw new Error('PDF source release identity does not match')
    const archive = pdfSourceArchiveRecord(manifest.pdfSources, version)
    if (archive.url !== `https://updates.hexbot.app/${path}/${archive.file}`)
      throw new Error('PDF source URL does not match the immutable publication path')
    const file = join(directory, path, archive.file)
    if ((await lstat(file)).size !== archive.bytes || await pdfFileHash(file, archive.bytes) !== archive.sha256)
      throw new Error('The PDF source companion must be complete and verified before publication')
    sources.push({ archive, file, key: `${path}/${archive.file}` })
  }
  for (const { archive, file, key } of sources) {
    await run('aws', ['s3', 'cp', file, `s3://${bucket}/${key}`, '--no-progress',
      '--cache-control', 'public, max-age=31536000, immutable'])
    let available = false
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await fetch(archive.url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(10_000) })
        if (response.ok && response.headers.get('content-length') === String(archive.bytes)) {
          available = true
          break
        }
      } catch {}
      if (attempt < 3) await wait((attempt + 1) * 1000)
    }
    if (!available) throw new Error(`The public PDF source companion is unavailable or has the wrong size: ${archive.url}`)
    const response = await fetch(archive.url, { method: 'GET', redirect: 'error',
      headers: { 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(10 * 60 * 1000) })
    if (!response.ok || !response.body || response.headers.get('content-length') !== String(archive.bytes))
      throw new Error(`The public PDF source companion could not be verified: ${archive.url}`)
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of response.body) {
      bytes += chunk.length
      if (bytes > archive.bytes) throw new Error(`The public PDF source companion exceeds its declared size: ${archive.url}`)
      hash.update(chunk)
    }
    if (bytes !== archive.bytes || hash.digest('hex') !== archive.sha256)
      throw new Error(`The public PDF source companion checksum does not match: ${archive.url}`)
  }
  return sources.map(item => item.archive)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, version, bucket] = process.argv.slice(2)
  if (!directory || !version || !bucket) throw new Error('Usage: node publish-pdf-sources.mjs UPDATES_ROOT VERSION R2_BUCKET')
  console.log(await publishPdfSources(resolve(directory), version, bucket))
}
