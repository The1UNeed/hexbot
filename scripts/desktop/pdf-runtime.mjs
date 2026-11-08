// Assemble the macOS PDF VM runtime from explicitly prepared guest assets.
import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { access, chmod, cp, lstat, mkdir, readFile, readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

export const PDF_RUNTIME_FILES = Object.freeze([
  'hexbot-pdf-vm', 'manifest.json', 'kernel', 'initramfs', 'rootfs',
  'kernel.provenance.json', 'PROVENANCE.json', 'THIRD_PARTY_NOTICES', 'SOURCES.json'
])
const limits = { kernel: 64, initramfs: 32, rootfs: 192, 'hexbot-pdf-vm': 64, 'manifest.json': 1 / 8, 'SOURCES.json': 8, THIRD_PARTY_NOTICES: 8 }
const digestPattern = /^[a-f0-9]{64}$/
const repair = 'The PDF VM runtime is missing or damaged. Update or repair Hexbot with the installer.'

export async function pdfFileHash(path, limit) {
  const metadata = await lstat(path)
  if (!metadata.isFile() || !metadata.size || metadata.size > limit) throw new Error(`${repair} Invalid file: ${basename(path)}`)
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path)) {
    size += chunk.length
    if (size > limit) throw new Error(`${repair} File exceeds its limit: ${basename(path)}`)
    hash.update(chunk)
  }
  if (size !== metadata.size) throw new Error(`${repair} File changed while being checked.`)
  return hash.digest('hex')
}

async function record(directory, name) {
  await pdfFileHash(join(directory, name), (limits[name] ?? 2) * 1024 * 1024)
  return JSON.parse(await readFile(join(directory, name), 'utf8'))
}

async function inspectPdfRuntime(directory, arch, { helper = true } = {}) {
  const architecture = { arm64: 'aarch64', x64: 'x86_64' }[arch]
  if (!architecture) throw new Error('Unsupported PDF VM runtime architecture')
  const expected = PDF_RUNTIME_FILES.filter(name => helper || name !== 'hexbot-pdf-vm')
  const actual = await readdir(directory)
  if (actual.sort().join('\n') !== [...expected].sort().join('\n')) throw new Error(`${repair} Unexpected PDF runtime files.`)
  const manifest = await record(directory, 'manifest.json')
  if (manifest.version !== 1 || manifest.architecture !== architecture ||
      Object.keys(manifest.files ?? {}).sort().join(',') !== 'initramfs,kernel,rootfs')
    throw new Error(`${repair} PDF VM architecture or manifest does not match.`)
  const files = {}
  for (const name of expected) {
    files[`pdf/${name}`] = await pdfFileHash(join(directory, name), (limits[name] ?? 2) * 1024 * 1024)
    if (['kernel', 'initramfs', 'rootfs'].includes(name) &&
        (!digestPattern.test(manifest.files[name]) || files[`pdf/${name}`] !== manifest.files[name]))
      throw new Error(`${repair} PDF VM checksum failed: ${name}`)
  }
  const provenance = await record(directory, 'PROVENANCE.json')
  const sources = await record(directory, 'SOURCES.json')
  if (provenance.version !== 1 || sources.version !== 1 ||
      provenance.architecture !== architecture || sources.architecture !== architecture ||
      !['prototype-not-release-ready', 'release-ready'].includes(provenance.status))
    throw new Error(`${repair} PDF VM provenance does not match.`)
  if (helper) {
    const bytes = await readFile(join(directory, 'hexbot-pdf-vm'))
    if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0xfeedfacf ||
        bytes.readUInt32LE(4) !== (arch === 'arm64' ? 0x100000c : 0x1000007))
      throw new Error(`${repair} PDF VM helper does not match the package architecture.`)
    await access(join(directory, 'hexbot-pdf-vm'), constants.R_OK | constants.X_OK)
  }
  return { files, provenance, sources }
}

export async function validatePdfRuntime(directory, arch, options) {
  try { return await inspectPdfRuntime(directory, arch, options) } catch (error) {
    if (error.message?.startsWith(repair)) throw error
    throw new Error(repair, { cause: error })
  }
}

export function pdfSourceArchiveRecord(record, version) {
  if (!record || Object.keys(record).sort().join(',') !== 'bytes,file,sha256,url' ||
      typeof record.file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(record.file) ||
      !digestPattern.test(record.sha256) || !Number.isSafeInteger(record.bytes) ||
      record.bytes <= 0 || record.bytes > 8 * 1024 ** 3)
    throw new Error('The PDF VM corresponding-source archive record is incomplete.')
  const url = new URL(record.url)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      basename(url.pathname) !== record.file ||
      ![version, record.sha256].some(identity => identity && record.file.includes(identity) && url.pathname.includes(identity)))
    throw new Error('The PDF VM corresponding-source archive needs an immutable versioned HTTPS URL.')
  return { file: record.file, sha256: record.sha256, bytes: record.bytes, url: record.url }
}

export async function validatePdfRelease({ provenance, sources }, { version, sourceArchivePath, verifySources }) {
  if (provenance.status !== 'release-ready' || provenance.sourceArchiveComplete !== true ||
      provenance.noticesComplete !== true || sources.completeCorrespondingSourceArchive !== true)
    throw new Error('The PDF VM assets are a prototype. Complete the native assets, notices and corresponding sources before release.')
  const archive = pdfSourceArchiveRecord(sources.archive, version)
  if (JSON.stringify(pdfSourceArchiveRecord(provenance.sourceArchive, version)) !== JSON.stringify(archive))
    throw new Error('The PDF VM source archive records disagree.')
  if (!sourceArchivePath || basename(sourceArchivePath) !== archive.file ||
      (await lstat(sourceArchivePath)).size !== archive.bytes ||
      await pdfFileHash(sourceArchivePath, archive.bytes) !== archive.sha256)
    throw new Error('The complete PDF VM corresponding-source archive must be present and verified before release.')
  if (!verifySources) throw new Error('The PDF VM corresponding-source content verifier is required before release.')
  await verifySources(sourceArchivePath, sources)
  return archive
}

export async function stagePdfRuntime({ repository, destination, arch, assetsDirectory, sourceArchivePath,
  channel = 'dev', version, run, verifySources }) {
  if (!assetsDirectory) throw new Error('Prepare the PDF VM guest assets and set HEXBOT_PDF_ASSETS_DIRECTORY before building a Full macOS runtime.')
  const assets = resolve(assetsDirectory)
  const validated = await validatePdfRuntime(assets, arch, { helper: false })
  let archive
  if (channel !== 'dev') archive = await validatePdfRelease(validated, { version, sourceArchivePath, verifySources })
  else if (validated.provenance.status === 'prototype-not-release-ready' &&
      (validated.provenance.sourceArchiveComplete !== false || validated.provenance.noticesComplete !== false ||
       validated.provenance.sourceArchive !== null || validated.sources.completeCorrespondingSourceArchive !== false ||
       validated.sources.archive !== null || !/\bincomplete\b/i.test(await readFile(join(assets, 'THIRD_PARTY_NOTICES'), 'utf8'))))
    throw new Error('Development PDF VM prototypes must retain incomplete flags and explicitly INCOMPLETE notices.')
  await mkdir(destination)
  for (const file of PDF_RUNTIME_FILES.filter(name => name !== 'hexbot-pdf-vm'))
    await cp(join(assets, file), join(destination, file))
  await run(join(repository, 'backend/pdf-runtime/macos/build.sh'), [join(destination, 'hexbot-pdf-vm'), arch === 'arm64' ? 'arm64' : 'x86_64'])
  await chmod(join(destination, 'hexbot-pdf-vm'), 0o755)
  const complete = await validatePdfRuntime(destination, arch)
  for (const [file, hash] of Object.entries(validated.files))
    if (complete.files[file] !== hash) throw new Error('The PDF VM assets changed while staging. Build them again in a new owned directory.')
  return { ...complete, archive }
}
