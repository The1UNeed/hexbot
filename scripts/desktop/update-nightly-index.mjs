// Keep a public list of recent nightlies on the update server so hexbot.app
// can show them. The release workflow runs this after publishing a nightly:
//
//   node scripts/desktop/update-nightly-index.mjs --version <v> --commit <sha> [--index <existing.json>] [--out <file>]
//
// Package names follow apps/desktop/electron-builder.*.yml, the same rule
// finalize-release.mjs uses for the stable manifest. Files are never deleted
// from the bucket, so every listed version stays downloadable.
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const keep = 30

export function nightlyFiles(version) {
  const names = prefix => ({
    'mac-arm64': `${prefix}-${version}-mac-arm64.dmg`,
    'mac-x64': `${prefix}-${version}-mac-x64.dmg`,
    linux: `${prefix}-${version}-linux-x86_64.AppImage`,
    'linux-deb': `${prefix}-${version}-linux-amd64.deb`
  })
  return { full: names('Hexbot'), client: names('HexbotClient') }
}

export function updateNightlyIndex(existing, { version, commit, date = new Date().toISOString() }) {
  if (!/-nightly\./.test(version)) throw new Error(`${version} is not a nightly version`)
  const rest = (existing?.nightlies ?? []).filter(n => n.version !== version)
  const entry = { version, date, commit: commit.slice(0, 7), files: nightlyFiles(version) }
  return { nightlies: [entry, ...rest].slice(0, keep) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const option = name => {
    const index = args.indexOf(name)
    return index === -1 ? undefined : args[index + 1]
  }
  const version = option('--version')
  const commit = option('--commit')
  if (!version || !commit) throw new Error('Usage: update-nightly-index.mjs --version <v> --commit <sha> [--index <json>] [--out <file>]')
  const indexFile = option('--index')
  const existing = indexFile ? JSON.parse(await readFile(indexFile, 'utf8').catch(() => '{}')) : {}
  const updated = updateNightlyIndex(existing, { version, commit })
  const out = option('--out') ?? 'dist/nightlies.json'
  await writeFile(out, `${JSON.stringify(updated, null, 2)}\n`)
  console.log(`${out}: ${updated.nightlies.length} nightlies, newest ${version}`)
}
