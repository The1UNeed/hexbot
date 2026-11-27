import { beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({
  os: 'ios',
  projectId: 'project-1' as string | undefined,
  status: 'granted',
  canAskAgain: true,
  request: vi.fn(),
  schedule: vi.fn(),
  openSettings: vi.fn(),
  token: vi.fn(),
  channel: vi.fn()
}))
vi.mock('react-native', () => ({
  Linking: { openSettings: mock.openSettings },
  Platform: {
    get OS() {
      return mock.os
    }
  }
}))
vi.mock('expo-constants', () => ({
  default: {
    get expoConfig() {
      return { extra: mock.projectId ? { eas: { projectId: mock.projectId } } : {} }
    }
  }
}))
vi.mock('expo-notifications', () => ({
  getPermissionsAsync: () =>
    Promise.resolve({ status: mock.status, canAskAgain: mock.canAskAgain }),
  scheduleNotificationAsync: mock.schedule,
  requestPermissionsAsync: mock.request,
  getExpoPushTokenAsync: mock.token,
  setNotificationChannelAsync: mock.channel,
  AndroidImportance: { HIGH: 4 }
}))
import { allowPush, notificationTarget, pushPermission, registerPush, testNotification } from './push'

beforeEach(() => {
  mock.os = 'ios'
  mock.projectId = 'project-1'
  mock.status = 'granted'
  mock.canAskAgain = true
  mock.schedule.mockReset().mockResolvedValue('id')
  mock.openSettings.mockReset().mockResolvedValue(undefined)
  mock.request.mockReset().mockResolvedValue({ status: 'granted' })
  mock.token.mockReset().mockResolvedValue({ data: 'ExponentPushToken[abc]' })
  mock.channel.mockReset().mockResolvedValue(null)
})
describe('check-in push', () => {
  it('registers this phone with the daemon, once per token', async () => {
    const rpc = vi.fn().mockResolvedValue({ ok: true })
    await registerPush(rpc, 'device-1')
    await registerPush(rpc, 'device-1')
    expect(rpc).toHaveBeenCalledOnce()
    expect(mock.token).toHaveBeenCalledWith({ projectId: 'project-1' })
    expect(rpc).toHaveBeenCalledWith('hexbot.devices.set_push', {
      token: 'ExponentPushToken[abc]',
      platform: 'ios'
    })
  })
  it('makes the Android channel before asking, as Android 13 needs', async () => {
    mock.os = 'android'
    mock.status = 'undetermined'
    const order: string[] = []
    mock.channel.mockImplementation(async () => order.push('channel'))
    mock.request.mockImplementation(async () => (order.push('ask'), { status: 'granted' }))
    await registerPush(vi.fn().mockResolvedValue({ ok: true }), 'android-device')
    expect(order).toEqual(['channel', 'ask'])
    expect(mock.channel).toHaveBeenCalledWith('checkins', { name: 'Bot messages', importance: 4 })
  })
  it('asks once, and does nothing when the user says no', async () => {
    mock.status = 'undetermined'
    mock.request.mockResolvedValue({ status: 'denied' })
    const rpc = vi.fn()
    await registerPush(rpc)
    expect(mock.request).toHaveBeenCalledOnce()
    expect(rpc).not.toHaveBeenCalled()
  })
  it('skips builds without an EAS project, and the web', async () => {
    const rpc = vi.fn()
    mock.projectId = undefined
    await registerPush(rpc)
    mock.projectId = 'project-1'
    mock.os = 'web'
    await registerPush(rpc)
    expect(mock.token).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })
  it('tolerates a daemon from before check-ins', async () => {
    const rpc = vi.fn().mockRejectedValue(new Error('unknown method: hexbot.devices.set_push'))
    await expect(registerPush(rpc)).resolves.toBeUndefined()
  })
  it('reads the section a notification opens, and on which daemon', () => {
    expect(notificationTarget({ section: 's1', device: 'd1' })).toEqual({ section: 's1', device: 'd1' })
    expect(notificationTarget({ section: 's1' })).toEqual({ section: 's1', device: null })
    expect(notificationTarget({})).toBeNull()
    expect(notificationTarget(null)).toBeNull()
  })
})
describe('turning notifications on', () => {
  it('asks while the system still shows its prompt, then registers this phone', async () => {
    mock.status = 'undetermined'
    const rpc = vi.fn().mockResolvedValue({ ok: true })
    await expect(allowPush(rpc, 'device-allow')).resolves.toBe('granted')
    expect(mock.request).toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledWith('hexbot.devices.set_push', expect.anything())
    expect(mock.openSettings).not.toHaveBeenCalled()
  })
  it('opens Settings once the system no longer asks', async () => {
    mock.status = 'denied'
    mock.canAskAgain = false
    const rpc = vi.fn()
    await expect(allowPush(rpc)).resolves.toBe('denied')
    expect(mock.openSettings).toHaveBeenCalledOnce()
    expect(mock.request).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })
  it('reports a build or platform that cannot take pushes', async () => {
    mock.os = 'web'
    await expect(pushPermission()).resolves.toEqual({ status: 'unavailable', canAsk: false })
    await expect(allowPush(vi.fn())).resolves.toBe('unavailable')
    expect(mock.request).not.toHaveBeenCalled()
  })
  it('shows a test on this phone at once', async () => {
    await testNotification()
    expect(mock.schedule).toHaveBeenCalledWith({
      content: expect.objectContaining({ title: 'Notifications are on' }),
      trigger: null
    })
  })
})
