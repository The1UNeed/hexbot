import { describe, expect, it } from 'vitest'
import { describeDownload } from './downloadInfo'

const updates = 'https://updates.hexbot.app'

describe('describeDownload', () => {
  it('reads a stable build', () => {
    expect(describeDownload(`${updates}/full/mac/arm64/Hexbot-0.1.5-alpha.1-mac-arm64.dmg`)).toEqual({
      edition: 'full', os: 'mac', arch: 'arm64', format: 'dmg', version: '0.1.5-alpha.1', channel: 'stable',
    })
  })

  it('reads a nightly client build', () => {
    expect(describeDownload(`${updates}/client/linux/x64/HexbotClient-0.1.6-nightly.20260922.1-linux-x64.AppImage`)).toEqual({
      edition: 'client', os: 'linux', arch: 'x64', format: 'AppImage', version: '0.1.6-nightly.20260922.1', channel: 'nightly',
    })
  })

  it('ignores other links', () => {
    expect(describeDownload('https://github.com/The1UNeed/hexbot/releases')).toBeNull()
    expect(describeDownload(`${updates}/full/mac/arm64/latest-mac.yml`)).toBeNull()
  })
})
