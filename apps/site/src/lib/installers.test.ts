import { afterEach, describe, expect, it, vi } from 'vitest'
import { installers, readManifest } from './installers'

const version = '0.1.5-nightly.20261003.42'
const base = `https://updates.hexbot.app/install/${version}`
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
// The shape make-install-manifest.mjs writes, trimmed to what the page reads.
const manifest = (channel: string, targets: Record<string, unknown> = {
  'macos-aarch64': { full: {}, installerApp: { url: `${base}/HexbotInstaller-${version}-mac-arm64.dmg`, sha256: 'a', size: 9 } },
  'macos-x86_64': { full: {}, installerApp: { url: `${base}/HexbotInstaller-${version}-mac-x64.dmg`, sha256: 'b', size: 9 } },
  'linux-x86_64': { full: {}, installerApp: { url: `${base}/HexbotInstaller-${version}-linux-x86_64.AppImage`, sha256: 'c', size: 9 } },
}) => ({ schema: 1, channel, version, minInstaller: version, targets })

describe('readManifest', () => {
  it('lists the installer for every target in page order', () => {
    const result = readManifest(manifest('nightly'), 'nightly')
    expect(result?.version).toBe(version)
    expect(result?.builds.map(b => [b.key, b.url])).toEqual([
      ['mac-arm64', `${base}/HexbotInstaller-${version}-mac-arm64.dmg`],
      ['mac-x64', `${base}/HexbotInstaller-${version}-mac-x64.dmg`],
      ['linux', `${base}/HexbotInstaller-${version}-linux-x86_64.AppImage`],
    ])
  })

  it('skips targets without an installer and rejects other manifests', () => {
    const partial = readManifest(manifest('nightly', { 'linux-x86_64': { installerApp: { url: `${base}/x.AppImage` } }, 'macos-aarch64': { full: {} } }), 'nightly')
    expect(partial?.builds.map(b => b.key)).toEqual(['linux'])
    expect(readManifest(manifest('nightly', { 'macos-aarch64': { full: {} } }), 'nightly')).toBeNull()
    expect(readManifest(manifest('stable'), 'nightly')).toBeNull()
    expect(readManifest({ ...manifest('nightly'), schema: 2 }, 'nightly')).toBeNull()
  })
})

describe('installers', () => {
  it('prefers stable and falls back to nightly when stable is not published', async () => {
    const both = async (url: string) => manifest(url.endsWith('/stable.json') ? 'stable' : 'nightly')
    expect((await installers(both))?.track).toBe('stable')
    const nightlyOnly = async (url: string) => (url.endsWith('/nightly.json') ? manifest('nightly') : null)
    expect((await installers(nightlyOnly))?.track).toBe('nightly')
  })

  it('returns null when no manifest is published or the server fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await installers(async () => null)).toBeNull()
    expect(await installers(async () => { throw new Error('503') })).toBeNull()
  })

  it.each([false, 0, '', {}, []])('does not switch to nightly for invalid stable JSON %j', async stable => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const load = vi.fn(async (url: string) => url.endsWith('/stable.json') ? stable : manifest('nightly'))
    expect(await installers(load)).toBeNull()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('does not treat a successful JSON null response as an unpublished stable manifest', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetcher = vi.fn(async () => Response.json(null))
    vi.stubGlobal('fetch', fetcher)
    expect(await installers()).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

it('resolves relative installer paths against the update server', () => {
  const result = readManifest(manifest('stable', { 'linux-x86_64': { installerApp: { url: 'install/1.2.3/installer.AppImage' } } }), 'stable')
  expect(result?.builds[0].url).toBe('https://updates.hexbot.app/install/1.2.3/installer.AppImage')
  expect(readManifest(manifest('stable', { 'linux-x86_64': { installerApp: { url: '//attacker.example/installer.AppImage' } } }), 'stable')).toBeNull()
})
