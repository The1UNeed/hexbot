import { describe, expect, it } from 'vitest'
import { packageRows } from './downloads'

const packages = { mac: { arm64: 'arm.dmg', x64: 'intel.dmg' }, linux: { AppImage: 'linux.AppImage', deb: 'linux.deb' } }

describe('stable package rows', () => {
  it('keeps pre-Windows manifests usable without inventing a Windows URL', () => {
    expect(packageRows('full', packages).map(row => row.key)).toEqual(['mac-arm64', 'mac-x64', 'linux', 'linux-deb'])
  })

  it('offers the published Windows executable for each edition', () => {
    expect(packageRows('client', { ...packages, windows: { x64: 'HexbotClient-0.1.6-win-x64.exe' } }).at(-1)).toEqual({
      key: 'windows', label: 'Windows x64', url: 'https://updates.hexbot.app/client/win/x64/HexbotClient-0.1.6-win-x64.exe',
    })
  })
})
