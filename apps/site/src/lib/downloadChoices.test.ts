import { describe, expect, it } from 'vitest'
import { detectTarget } from './detectPlatform'
import { downloadChoices } from './downloadChoices'
import type { Installers } from './installers'

const installers: Installers = {
  track: 'stable', version: '0.1.6', builds: [
    { key: 'mac-arm64', name: 'Mac (Apple Silicon)', pill: 'dmg', url: 'https://updates.hexbot.app/mac.dmg' },
    { key: 'linux', name: 'Linux', pill: 'AppImage', url: 'https://updates.hexbot.app/linux.AppImage' },
  ],
}

describe('primary download choices', () => {
  it.each([
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'arm', 'Mac (Apple Silicon)', 'mac.dmg'],
    ['Mozilla/5.0 (X11; Linux x86_64)', 'x86', 'Linux', 'linux.AppImage'],
  ])('keeps the installer URL and label without a package feed: %s', (userAgent, architecture, name, file) => {
    const choices = JSON.parse(JSON.stringify(downloadChoices(null, installers)))
    const target = detectTarget({ userAgent, architecture })
    expect(choices.find((build: { key: string }) => build.key === target)).toMatchObject({
      kind: 'installer', name, url: `https://updates.hexbot.app/${file}`,
    })
  })

  it('keeps the package fallback when no installer is published', () => {
    expect(downloadChoices({ channel: 'stable', version: '0.1.6', built: '', full: [{ label: 'Mac', url: '/full.dmg' }], client: [] }, null)[0])
      .toMatchObject({ key: 'mac-arm64', kind: 'full', url: '/full.dmg' })
    expect(downloadChoices(null, null)).toEqual([])
  })
})
