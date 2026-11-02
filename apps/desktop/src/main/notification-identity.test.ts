import { readFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { appId } from '../../../../scripts/desktop/release-version.mjs'
import { setNotificationIdentity } from './notification-identity'

const identities = new Map<string, [string, string]>([
  ['stable', ['app.hexbot.desktop', 'app.hexbot.client']],
  ['nightly', ['app.hexbot.desktop.nightly', 'app.hexbot.client.nightly']],
  ['dev', ['app.hexbot.desktop.dev', 'app.hexbot.client.dev']]
])

it.each([...identities])(
  'uses the %s shortcut identity for each Windows edition',
  (_channel, ids) => {
    for (const id of ids) {
      const app = { setAppUserModelId: vi.fn() }
      setNotificationIdentity(app, 'win32', id)
      expect(app.setAppUserModelId).toHaveBeenCalledExactlyOnceWith(id)
    }
  }
)

it('packaging app ids are exactly the shortcut identities notifications use', () => {
  for (const [channel, ids] of identities) {
    expect(appId(channel)).toBe(ids[0])
    expect(appId(channel, true)).toBe(ids[1])
  }
})

it.each(['darwin', 'linux'] as const)('leaves %s notification identity alone', platform => {
  const app = { setAppUserModelId: vi.fn() }
  setNotificationIdentity(app, platform, 'app.hexbot.desktop')
  expect(app.setAppUserModelId).not.toHaveBeenCalled()
})

it('sets the build identity before readiness and derives it from the packaging helper', async () => {
  const main = await readFile(new URL('./index.ts', import.meta.url), 'utf8')
  const configure = main.indexOf(
    'setNotificationIdentity(app, process.platform, __HEXBOT_APP_ID__)'
  )
  expect(configure).toBeGreaterThan(-1)
  expect(configure).toBeLessThan(main.indexOf('app.whenReady()'))
  const build = await readFile(new URL('../../electron.vite.config.ts', import.meta.url), 'utf8')
  expect(build).toContain("import { appId } from '../../scripts/desktop/release-version.mjs'")
  expect(build).toMatch(/__HEXBOT_APP_ID__: JSON.stringify\(\s*appId\(/)
})
