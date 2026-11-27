import { expect, it } from 'vitest'
import { stableBuilds, targets } from './downloads'

it('lists Windows x64 stable packages in the same order as the download targets', () => {
  for (const [edition, prefix] of [['full', 'Hexbot'], ['client', 'HexbotClient']] as const) {
    const builds = stableBuilds(edition, {
      mac: { arm64: 'arm.dmg', x64: 'intel.dmg' }, linux: { AppImage: 'linux.AppImage', deb: 'linux.deb' },
      win: { x64: `${prefix}-1.2.3-win-x64.exe` },
    })
    expect(builds).toHaveLength(targets.length)
    expect(targets.at(-1)?.key).toBe('win-x64')
    expect(builds.at(-1)?.url).toBe(`https://updates.hexbot.app/${edition}/win/x64/${prefix}-1.2.3-win-x64.exe`)
  }
})
