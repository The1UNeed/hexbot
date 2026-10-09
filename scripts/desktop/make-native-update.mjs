// Build the daemon updater's versioned archive and manifest without publishing.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNativeArchive, updateTarget } from './native-runtime.mjs'

export async function makeNativeUpdate(bundle, output) {
  const metadata = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'))
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(metadata.version)) throw new Error('Invalid runtime version')
  const target = updateTarget(metadata.target)
  const path = ['daemon', 'native', metadata.version, target]
  const directory = join(output, ...path)
  await mkdir(directory, { recursive: true })
  const filename = `hexbot-native-${metadata.version}-${target}.tar.gz`
  const manifest = await createNativeArchive(bundle, join(directory, filename))
  manifest.url = [...path, filename].join('/')
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return { directory, filename, manifest }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , bundle, output] = process.argv
  if (!bundle || !output) throw new Error('Usage: node make-native-update.mjs BUNDLE OUTPUT')
  const result = await makeNativeUpdate(resolve(bundle), resolve(output))
  console.log(`Prepared ${result.directory}`)
}
