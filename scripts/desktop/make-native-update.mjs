// Build the daemon updater's versioned archive and manifest without publishing.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNativeArchive, updateTarget } from './native-runtime.mjs'
import { pdfFileHash, validatePdfRelease, validatePdfRuntime } from './pdf-runtime.mjs'
const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const run = promisify(execFile)

export async function makeNativeUpdate(bundle, output, {
  channel = process.env.HEXBOT_CHANNEL || process.env.CHANNEL || 'dev',
  sourceArchivePath = process.env.HEXBOT_PDF_SOURCE_ARCHIVE
} = {}) {
  const metadata = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'))
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(metadata.version)) throw new Error('Invalid runtime version')
  const target = updateTarget(metadata.target)
  const path = ['daemon', 'native', metadata.version, target]
  const directory = join(output, ...path)
  let sourceArchive
  if (metadata.target.startsWith('darwin-')) {
    if (metadata.pdfVm !== 1) throw new Error('Native macOS archives require the complete PDF VM runtime')
    const pdf = await validatePdfRuntime(join(bundle, 'pdf'), metadata.target.split('-')[1])
    if (channel !== 'dev') {
      sourceArchive = await validatePdfRelease(pdf, { version: metadata.version, sourceArchivePath,
        verifySources: async archive => run('python3', [join(repository, 'backend/pdf-runtime/guest/verify-sources.py'),
          '--archive', archive, '--sources', join(bundle, 'pdf/SOURCES.json'),
          '--notices', join(bundle, 'pdf/THIRD_PARTY_NOTICES'),
          '--lock', join(repository, 'backend/pdf-runtime/guest/assets.lock.json'), '--arch', pdf.sources.architecture,
          '--version', metadata.version]) })
      const expected = `https://updates.hexbot.app/${[...path, sourceArchive.file].join('/')}`
      if (sourceArchive.url !== expected) throw new Error('The PDF VM source URL does not match its immutable release artifact path')
    }
  }
  await mkdir(directory, { recursive: true })
  if (sourceArchive) {
    const copy = join(directory, sourceArchive.file)
    await cp(sourceArchivePath, copy)
    if (await pdfFileHash(copy, sourceArchive.bytes) !== sourceArchive.sha256)
      throw new Error('The PDF VM corresponding-source archive changed while being copied')
  }
  const filename = `hexbot-native-${metadata.version}-${target}.${metadata.target === 'win32-x64' ? 'zip' : 'tar.gz'}`
  const manifest = await createNativeArchive(bundle, join(directory, filename))
  if (sourceArchive) manifest.pdfSources = sourceArchive
  manifest.path = [...path, filename].join('/')
  manifest.url = `https://updates.hexbot.app/${manifest.path}`
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return { directory, filename, manifest }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , bundle, output] = process.argv
  if (!bundle || !output) throw new Error('Usage: node make-native-update.mjs BUNDLE OUTPUT')
  const result = await makeNativeUpdate(resolve(bundle), resolve(output))
  console.log(`Prepared ${result.directory}`)
}
