/**
 * Is the daemon behind the app talking to it? (T3 Code's versionSkew.ts.)
 *
 * Two nightly builds compare their whole version, date and run included.
 * Every other pair compares `major.minor.patch` only, so a stable app and a
 * nightly daemon cut from the same base do not nag. A daemon ahead of the
 * app needs nothing. A version that does not parse counts as different.
 */

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/

interface Parsed {
  core: [number, number, number]
  prerelease: string[]
}

export function parseVersion(version: string): Parsed | null {
  const match = SEMVER.exec(version.trim())

  if (!match) {
    return null
  }

  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : []
  }
}

function compareIdentifiers(a: string, b: string): number {
  const numeric = /^\d+$/.test(a) && /^\d+$/.test(b)

  if (numeric) {
    return Number(a) - Number(b)
  }

  return a < b ? -1 : a > b ? 1 : 0
}

/** SemVer ordering: cores first, then prerelease identifiers. */
export function compareVersions(a: Parsed, b: Parsed): number {
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) {
      return a.core[index]! - b.core[index]!
    }
  }

  if (!a.prerelease.length || !b.prerelease.length) {
    return Number(!a.prerelease.length) - Number(!b.prerelease.length)
  }

  const length = Math.max(a.prerelease.length, b.prerelease.length)

  for (let index = 0; index < length; index += 1) {
    const left = a.prerelease[index]
    const right = b.prerelease[index]

    if (left === undefined || right === undefined) {
      return left === undefined ? -1 : 1
    }

    const order = compareIdentifiers(left, right)

    if (order !== 0) {
      return order
    }
  }

  return 0
}

export const isNightly = (version: string): boolean =>
  parseVersion(version)?.prerelease[0] === 'nightly'

/** True when `daemonVersion` is older than `appVersion` in a way worth acting on. */
export function daemonBehind(appVersion: null | string, daemonVersion: null | string): boolean {
  if (!appVersion || !daemonVersion) {
    return false
  }

  const app = parseVersion(appVersion)
  const daemon = parseVersion(daemonVersion)

  if (!app || !daemon) {
    return appVersion.trim() !== daemonVersion.trim()
  }

  if (isNightly(appVersion) && isNightly(daemonVersion)) {
    return compareVersions(daemon, app) < 0
  }

  return compareVersions({ ...daemon, prerelease: [] }, { ...app, prerelease: [] }) < 0
}
