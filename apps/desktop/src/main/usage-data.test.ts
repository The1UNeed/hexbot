import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readDesktopState } from './desktop-state'
import { captureUsage, sendDailyUsage, setUsageData, usageRefused } from './usage-data'

vi.mock('electron', () => ({ app: { getVersion: () => '1.2.3', on: vi.fn() } }))

const directories: string[] = []
async function stateFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'hexbot-usage-'))
  directories.push(directory)
  return join(directory, 'desktop-state.json')
}
afterEach(() =>
  Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
)

const sent = (send: ReturnType<typeof vi.fn>) =>
  send.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string))

describe('usage data', () => {
  it('sends nothing until the user turns it on', async () => {
    const file = await stateFile()
    const send = vi.fn()
    await sendDailyUsage({ file, key: 'phc_test', send })
    await captureUsage('app_error', { kind: 'renderer' }, { file, key: 'phc_test', send })
    expect(send).not.toHaveBeenCalled()
    expect(await readDesktopState(file)).toEqual({})
  })

  it('sends nothing from a build without a project key', async () => {
    const file = await stateFile()
    const send = vi.fn()
    await setUsageData(true, { file, key: '', send })
    expect(send).not.toHaveBeenCalled()
  })

  it('counts the day it is turned on, once, anonymously', async () => {
    const file = await stateFile()
    const send = vi.fn()
    const now = () => new Date('2026-10-31T10:00:00Z')
    await setUsageData(true, { file, key: 'phc_test', now, send })
    await sendDailyUsage({ file, key: 'phc_test', now, send })

    const [event] = sent(send)
    expect(send).toHaveBeenCalledTimes(1)
    expect(event).toMatchObject({
      api_key: 'phc_test',
      event: 'app_active',
      properties: {
        $geoip_disable: true,
        $process_person_profile: false,
        channel: 'stable',
        edition: 'full',
        surface: 'desktop',
        version: '1.2.3'
      }
    })
    expect(event.distinct_id).toBe((await readDesktopState(file)).usageId)
  })

  it('saves the choice without waiting on PostHog', async () => {
    const file = await stateFile()
    const send = vi.fn(() => new Promise<Response>(() => undefined))
    await setUsageData(true, { file, key: 'phc_test', send })
    expect(send).toHaveBeenCalledTimes(1)
    expect((await readDesktopState(file)).usageData).toBe(true)
  })

  it('forgets the install id when turned off', async () => {
    const file = await stateFile()
    const send = vi.fn()
    await setUsageData(true, { file, key: 'phc_test', send })
    await setUsageData(false, { file, key: 'phc_test', send })
    const state = await readDesktopState(file)
    expect(state.usageData).toBe(false)
    expect(state.usageId).toBeUndefined()
    expect(state.usageDay).toBeUndefined()
  })

  it('honours DO_NOT_TRACK and HEXBOT_USAGE_DATA=0', () => {
    expect(usageRefused({ DO_NOT_TRACK: '1' })).toBe(true)
    expect(usageRefused({ HEXBOT_USAGE_DATA: '0' })).toBe(true)
    expect(usageRefused({ DO_NOT_TRACK: '0' })).toBe(false)
    expect(usageRefused({})).toBe(false)
  })
})
