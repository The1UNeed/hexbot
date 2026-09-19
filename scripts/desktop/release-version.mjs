// Resolve the channel and version of one release, the way T3 Code's preflight
// job does (docs/channels.md, "Borrowed from T3 Code").
//
//   stable   a v<version> tag, or a manual run on main, which releases the
//            version in apps/desktop/package.json and lets the workflow
//            create the tag. A pushed tag must match package.json.
//            A plain X.Y.Z is a full release (GitHub "latest"); a version with a
//            suffix such as 0.1.5-alpha.1 is a GitHub prerelease.
//   nightly  <base>-nightly.<YYYYMMDD>.<run number>, where <base> is the next
//            patch after a plain X.Y.Z in package.json, or the same X.Y.Z when
//            package.json already carries a suffix (0.1.5-alpha.1 -> 0.1.5).
//            Always a prerelease, never "latest".
//
// As a CLI it prints GitHub Actions outputs:
//   node scripts/desktop/release-version.mjs --channel stable --ref refs/tags/v0.1.5-alpha.1
//   node scripts/desktop/release-version.mjs --channel stable --ref refs/heads/main
//   node scripts/desktop/release-version.mjs --channel nightly --run-number 42
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

export function nightlyBase(packageVersion) {
  const match = SEMVER.exec(packageVersion)
  if (!match) throw new Error(`apps/desktop/package.json version "${packageVersion}" is not SemVer`)
  const [, major, minor, patch, suffix] = match
  return suffix ? `${major}.${minor}.${patch}` : `${major}.${minor}.${Number(patch) + 1}`
}

export function resolveRelease({ channel, packageVersion, ref, date = new Date(), runNumber }) {
  if (channel === 'nightly') {
    const day = date.toISOString().slice(0, 10).replaceAll('-', '')
    if (!Number.isInteger(runNumber) || runNumber < 1)
      throw new Error('A nightly needs the workflow run number')
    const version = `${nightlyBase(packageVersion)}-nightly.${day}.${runNumber}`
    return { channel, version, tag: `v${version}`, prerelease: true, latest: false }
  }
  if (channel !== 'stable') throw new Error(`Unknown channel "${channel}". Use stable or nightly.`)
  // A manual run on main releases whatever package.json says.
  const tag = ref === 'refs/heads/main' ? `v${packageVersion}` : ref?.replace(/^refs\/tags\//, '')
  if (!tag?.startsWith('v'))
    throw new Error(`A stable release needs a v* tag or a manual run on main, got "${ref}"`)
  const version = tag.slice(1)
  const match = SEMVER.exec(version)
  if (!match) throw new Error(`Tag ${tag} is not v<SemVer>`)
  if (match[4]?.startsWith('nightly.'))
    throw new Error(`Tag ${tag} is a nightly version; nightlies are built by the schedule`)
  if (version !== packageVersion)
    throw new Error(`Tag ${tag} does not match apps/desktop/package.json (${packageVersion})`)
  return { channel, version, tag, prerelease: Boolean(match[4]), latest: !match[4] }
}

// Product names carry the channel so builds can be told apart and installed
// side by side. The [alpha] suffix stays until the first 1.0 release.
export function productName(channel, version, client = false) {
  const base = client ? 'Hexbot Client' : 'Hexbot'
  if (channel === 'nightly') return `${base} Nightly`
  if (channel === 'dev') return `${base} (dev)`
  return version.startsWith('0.') ? `${base} [alpha]` : base
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const option = name => {
    const index = args.indexOf(name)
    return index === -1 ? undefined : args[index + 1]
  }
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const packageVersion = JSON.parse(
    await readFile(resolve(repositoryRoot, 'apps/desktop/package.json'), 'utf8')
  ).version
  const release = resolveRelease({
    channel: option('--channel'),
    packageVersion,
    ref: option('--ref') ?? process.env.GITHUB_REF,
    runNumber: Number(option('--run-number') ?? process.env.GITHUB_RUN_NUMBER)
  })
  for (const [key, value] of Object.entries(release)) console.log(`${key}=${value}`)
}
