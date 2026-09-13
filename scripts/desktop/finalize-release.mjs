// After a stable release is published: point the website downloads and the
// Homebrew casks at the new version. The release workflow runs this and
// commits the result to main (T3 Code's "finalize" job does the same).
//
//   node scripts/desktop/finalize-release.mjs <version> <full-release-dir> <client-release-dir>
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { updateCask } from './update-cask.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export function downloadsManifest(version) {
  const names = prefix => ({
    mac: { arm64: `${prefix}-${version}-mac-arm64.dmg`, x64: `${prefix}-${version}-mac-x64.dmg` },
    linux: {
      // electron-builder's ${arch} is x86_64 for AppImage and amd64 for deb.
      AppImage: `${prefix}-${version}-linux-x86_64.AppImage`,
      deb: `${prefix}-${version}-linux-amd64.deb`
    }
  })
  return { published: true, version, ...names('Hexbot'), client: names('HexbotClient') }
}

export async function finalizeRelease(
  version,
  fullDirectory,
  clientDirectory,
  root = repositoryRoot
) {
  await writeFile(
    resolve(root, 'apps/site/public/downloads/manifest.json'),
    `${JSON.stringify(downloadsManifest(version), null, 2)}\n`
  )
  const full = await updateCask(
    fullDirectory,
    resolve(root, 'packaging/homebrew/hexbot.rb'),
    version
  )
  const client = await updateCask(
    clientDirectory,
    resolve(root, 'packaging/homebrew/hexbot-client.rb'),
    version,
    'HexbotClient'
  )
  return { full, client }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version, fullDirectory, clientDirectory] = process.argv.slice(2)
  if (!version || !fullDirectory || !clientDirectory)
    throw new Error(
      'Usage: node scripts/desktop/finalize-release.mjs <version> <full-release-dir> <client-release-dir>'
    )
  await finalizeRelease(version, resolve(fullDirectory), resolve(clientDirectory))
  console.log(`Finalized ${version}: downloads manifest and both casks updated`)
  console.log(
    JSON.stringify(
      JSON.parse(
        await readFile(resolve(repositoryRoot, 'apps/site/public/downloads/manifest.json'), 'utf8')
      ),
      null,
      2
    )
  )
}
