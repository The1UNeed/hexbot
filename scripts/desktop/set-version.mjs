// Write one version into every file that carries it:
//   apps/desktop/package.json   the app version (electron-builder, the updater)
//   hexbot/__init__.py          the daemon version (hexbot --version, daemon info)
// Usage: node scripts/desktop/set-version.mjs 0.1.6-alpha.1
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export async function setVersion(version, root = repositoryRoot) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error(`"${version}" is not a SemVer version`)
  const packageFile = resolve(root, 'apps/desktop/package.json')
  const packageJson = JSON.parse(await readFile(packageFile, 'utf8'))
  packageJson.version = version
  await writeFile(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`)

  const initFile = resolve(root, 'hexbot/__init__.py')
  const init = await readFile(initFile, 'utf8')
  const next = init.replace(/^__version__ = "[^"]*"$/m, `__version__ = "${version}"`)
  if (next === init) throw new Error(`No __version__ line in ${initFile}`)
  await writeFile(initFile, next)
  return version
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2]
  if (!version) throw new Error('Usage: node scripts/desktop/set-version.mjs <version>')
  console.log(`Set version ${await setVersion(version)}`)
}
