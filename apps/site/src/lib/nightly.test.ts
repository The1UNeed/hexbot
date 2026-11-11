import { describe, expect, it, vi } from 'vitest'
import { nightlyDate, nightlyDownloads, parseFeed } from './nightly'

const version = '0.1.5-nightly.20260913.2'
const feed = (prefix: string, os: 'mac' | 'linux' | 'win', arch: string) =>
  os === 'mac'
    ? `version: ${version}\nfiles:\n  - url: ${prefix}-${version}-mac-${arch}.zip\n    sha512: a\n    size: 1\n  - url: ${prefix}-${version}-mac-${arch}.dmg\n    sha512: b\n    size: 1\npath: ${prefix}-${version}-mac-${arch}.zip\n`
    : os === 'win' ? `version: ${version}\nfiles:\n  - url: ${prefix}-${version}-win-x64.exe\n    sha512: a\n    size: 2\npath: ${prefix}-${version}-win-x64.exe\n`
    : `version: ${version}\nfiles:\n  - url: ${prefix}-${version}-linux-x86_64.AppImage\n    sha512: a\n    size: 1\n  - url: ${prefix}-${version}-linux-amd64.deb\n    sha512: b\n    size: 1\npath: ${prefix}-${version}-linux-x86_64.AppImage\n`
const server = async (url: string) => {
  const m = url.match(/^https:\/\/updates\.hexbot\.app\/(full|client)\/(mac|linux|win)\/(\w+)\/nightly(?:-\w+)?\.yml$/)
  if (!m) throw new Error(`404 ${url}`)
  return feed(m[1] === 'full' ? 'Hexbot' : 'HexbotClient', m[2] as 'mac' | 'linux' | 'win', m[3])
}

describe('parseFeed', () => {
  it('reads the version and every file the feed names', () => {
    expect(parseFeed(feed('Hexbot', 'linux', 'x64'))).toEqual({
      version,
      files: [
        { url: `Hexbot-${version}-linux-x86_64.AppImage`, size: 1 },
        { url: `Hexbot-${version}-linux-amd64.deb`, size: 1 }
      ]
    })
    expect(parseFeed('not a feed')).toBeNull()
  })

  it('reads the build date out of a nightly version', () => {
    expect(nightlyDate(version)).toBe('13 September 2026')
    expect(nightlyDate('0.1.5-alpha.1')).toBeNull()
  })
})

describe('nightlyDownloads', () => {
  it('links the dmg, AppImage, deb and exe of both editions from the feed', async () => {
    const downloads = await nightlyDownloads(server)
    expect(downloads?.version).toBe(version)
    expect(downloads?.full.map(b => b.url)).toEqual([
      `https://updates.hexbot.app/full/mac/arm64/Hexbot-${version}-mac-arm64.dmg`,
      `https://updates.hexbot.app/full/mac/x64/Hexbot-${version}-mac-x64.dmg`,
      `https://updates.hexbot.app/full/linux/x64/Hexbot-${version}-linux-x86_64.AppImage`,
      `https://updates.hexbot.app/full/linux/x64/Hexbot-${version}-linux-amd64.deb`,
      `https://updates.hexbot.app/full/win/x64/Hexbot-${version}-win-x64.exe`
    ])
    expect(downloads?.client.at(-1)?.url).toBe(`https://updates.hexbot.app/client/win/x64/HexbotClient-${version}-win-x64.exe`)
    expect(downloads?.client[0]).toEqual({
      label: 'macOS, Apple Silicon',
      url: `https://updates.hexbot.app/client/mac/arm64/HexbotClient-${version}-mac-arm64.dmg`,
      size: 1
    })
  })

  it('returns null when a required feed is missing or the feeds disagree', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await nightlyDownloads(async () => { throw new Error('404') })).toBeNull()
    expect(await nightlyDownloads(async url => { if (url.includes('/mac/')) throw new Error('404'); return server(url) })).toBeNull()
    const skewed = async (url: string) =>
      (await server(url)).replace(/^version: .*$/m, url.includes('/client/') ? 'version: 0.1.5-nightly.20260912.1' : `version: ${version}`)
    expect(await nightlyDownloads(skewed)).toBeNull()
  })

  it('omits the Windows row for a nightly published before Windows builds existed', async () => {
    const downloads = await nightlyDownloads(async url => {
      if (url.includes('/win/')) throw new Error('404')
      return server(url)
    })
    expect(downloads?.version).toBe(version)
    expect(downloads?.full.some(b => b.url.includes('-win-x64.exe'))).toBe(false)
    expect(downloads?.full.length).toBe(4)
  })
})
