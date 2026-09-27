import { describe, expect, it } from 'vitest'
import { describeDownload } from './downloadInfo'

const updates = 'https://updates.hexbot.app'

// Artifact names as electron-builder writes them (see nightly.test.ts).
describe('describeDownload', () => {
  it('reads a stable Mac build', () => {
    expect(describeDownload(`${updates}/full/mac/arm64/Hexbot-0.1.5-alpha.1-mac-arm64.dmg`)).toEqual({
      edition: 'full', os: 'mac', arch: 'arm64', format: 'dmg', version: '0.1.5-alpha.1', channel: 'stable',
    })
  })

  it('reads Linux builds, whose file names use the packager arch', () => {
    expect(describeDownload(`${updates}/full/linux/x64/Hexbot-0.1.5-nightly.20260922.17-linux-x86_64.AppImage`)).toEqual({
      edition: 'full', os: 'linux', arch: 'x64', format: 'AppImage', version: '0.1.5-nightly.20260922.17', channel: 'nightly',
    })
    expect(describeDownload(`${updates}/client/linux/x64/HexbotClient-0.1.6-linux-amd64.deb`)).toEqual({
      edition: 'client', os: 'linux', arch: 'x64', format: 'deb', version: '0.1.6', channel: 'stable',
    })
  })

  it('ignores other links', () => {
    expect(describeDownload('https://github.com/The1UNeed/hexbot/releases')).toBeNull()
    expect(describeDownload(`${updates}/full/linux/x64/latest-linux.yml`)).toBeNull()
  })
})
