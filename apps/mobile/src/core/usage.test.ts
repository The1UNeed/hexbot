import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ os: 'ios', store: new Map<string, string>() }))
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mock.os
    },
    isPad: true
  }
}))
vi.mock('expo-crypto', () => ({ randomUUID: () => 'install-1' }))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: (key: string) => Promise.resolve(mock.store.get(key) ?? null),
    setItem: (key: string, value: string) => Promise.resolve(void mock.store.set(key, value))
  }
}))
import { version } from '../../../desktop/package.json'
import { captureUsage, loadUsageData, sendDailyUsage, setUsageData } from './usage'

const body = (send: ReturnType<typeof vi.fn>, call = 0) =>
  JSON.parse((send.mock.calls[call]![1] as RequestInit).body as string)

beforeEach(() => {
  mock.os = 'ios'
  mock.store.clear()
  vi.stubEnv('EXPO_PUBLIC_POSTHOG_KEY', 'phc_test')
})

describe('usage data', () => {
  it('is off and silent until the user turns it on', async () => {
    const send = vi.fn()
    expect(await loadUsageData()).toBe(false)
    await sendDailyUsage(new Date(), send)
    await captureUsage('app_error', { kind: 'TypeError' }, send)
    expect(send).not.toHaveBeenCalled()
  })

  it('counts the day it is turned on, once, without a person or a place', async () => {
    const send = vi.fn()
    const day = new Date('2026-10-31T08:00:00Z')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(day)
    await setUsageData(true, send)
    await sendDailyUsage(day, send)
    vi.useRealTimers()
    expect(send).toHaveBeenCalledTimes(1)
    expect(body(send)).toMatchObject({
      distinct_id: 'install-1',
      event: 'app_active',
      properties: {
        $geoip_disable: true,
        $os: 'iOS',
        $process_person_profile: false,
        device: 'tablet',
        surface: 'mobile',
        version
      }
    })
  })

  it('a daily check already running cannot undo turning it off', async () => {
    await setUsageData(true, vi.fn())
    const tomorrow = new Date(Date.now() + 86_400_000)
    await Promise.all([sendDailyUsage(tomorrow, vi.fn()), setUsageData(false)])
    expect(JSON.parse(mock.store.get('hexbot.usage')!)).toEqual({ on: false })
  })

  it('forgets the install id when turned off', async () => {
    await setUsageData(true, vi.fn())
    await setUsageData(false)
    expect(JSON.parse(mock.store.get('hexbot.usage')!)).toEqual({ on: false })
  })

  it('sends nothing from the browser preview or a build without a key', async () => {
    const send = vi.fn()
    mock.os = 'web'
    await setUsageData(true, send)
    mock.os = 'ios'
    vi.stubEnv('EXPO_PUBLIC_POSTHOG_KEY', '')
    await captureUsage('app_error', {}, send)
    expect(send).not.toHaveBeenCalled()
  })
})
