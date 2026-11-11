import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  NOTIFY_BODY,
  notifyUser,
  OPEN_SECTION_EVENT,
  systemNotificationSettings,
  useNotificationsPrompt
} from './notify'
import { setShownSection } from './page-visible'

const shown: { body?: string; onclick: null | (() => void); title: string }[] = []

class FakeNotification {
  static permission: NotificationPermission = 'granted'
  static requestPermission = vi.fn(async () => {
    FakeNotification.permission = 'granted'

    return 'granted' as NotificationPermission
  })
  onclick: null | (() => void) = null
  constructor(
    public title: string,
    options: { body?: string } = {}
  ) {
    shown.push(Object.assign(this, { body: options.body }))
  }
}

/** A tab on screen, in front or behind another window. */
function looking(focused: boolean) {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  vi.spyOn(document, 'hasFocus').mockReturnValue(focused)
}

afterEach(() => {
  shown.length = 0
  FakeNotification.permission = 'granted'
  setShownSection(null)
  localStorage.clear()
  sessionStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('notifyUser', () => {
  it('shortens a long reply to what the app accepts', () => {
    const notify = vi.fn()
    vi.stubGlobal('hexbot', { notify })
    notifyUser({ body: 'x'.repeat(2_500), sectionId: 'chat', title: 'Owl' })
    const sent = notify.mock.calls[0]![0] as { body: string }
    expect(sent.body).toHaveLength(NOTIFY_BODY)
    expect(sent.body.endsWith('…')).toBe(true)
  })

  it('asks the app to stay quiet only about the chat on screen, if its window is in front', () => {
    const notify = vi.fn()
    vi.stubGlobal('hexbot', { notify })
    setShownSection('chat')
    notifyUser({ body: 'Done.', sectionId: 'chat', title: 'Owl' })
    notifyUser({ body: 'Done.', sectionId: 'other', title: 'Fox' })
    notifyUser({ body: 'Ready.', title: 'Hexbot' })
    expect(
      notify.mock.calls.map(([input]) => (input as { backgroundOnly: boolean }).backgroundOnly)
    ).toEqual([true, false, false])
  })

  it('swallows a notification the app refuses', async () => {
    const refused = Promise.reject(new TypeError('Invalid body'))
    vi.stubGlobal('hexbot', { notify: () => refused })
    notifyUser({ body: 'Done.', title: 'Owl' })
    await expect(refused).rejects.toThrow('Invalid body')
  })

  it('notifies in a visible tab unless you are looking at that chat, and a click opens it', () => {
    vi.stubGlobal('Notification', FakeNotification)
    setShownSection('chat')
    looking(true)
    notifyUser({ body: 'Done.', sectionId: 'chat', title: 'Owl' })
    expect(shown).toHaveLength(0)
    // Another chat, in front.
    notifyUser({ body: 'Hi.', sectionId: 'other', title: 'Fox' })
    // The same chat, in a window behind another app.
    looking(false)
    notifyUser({ body: 'Done.', sectionId: 'chat', title: 'Owl' })
    expect(shown).toMatchObject([
      { body: 'Hi.', title: 'Fox' },
      { body: 'Done.', title: 'Owl' }
    ])
    const opened = vi.fn()
    window.addEventListener(OPEN_SECTION_EVENT, opened)
    shown[1]!.onclick!()
    window.removeEventListener(OPEN_SECTION_EVENT, opened)
    expect((opened.mock.calls[0]![0] as CustomEvent<string>).detail).toBe('chat')
  })

  it('treats a room on screen as looking at each of its conversations', () => {
    vi.stubGlobal('Notification', FakeNotification)
    setShownSection('room:r1')
    looking(true)
    notifyUser({ body: 'Approve?', sectionId: 'room:r1:s1', title: 'Approval needed' })
    notifyUser({ body: 'Approve?', sectionId: 'room:r10:s1', title: 'Approval needed' })
    expect(shown).toHaveLength(1)
  })

  it('shows nothing in a browser that has not allowed notifications', () => {
    FakeNotification.permission = 'default'
    vi.stubGlobal('Notification', FakeNotification)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    notifyUser({ body: 'Done.', title: 'Owl' })
    expect(shown).toHaveLength(0)
  })
})

describe('useNotificationsPrompt', () => {
  it('asks a browser that can still ask, and a test arrives once it is allowed', async () => {
    FakeNotification.permission = 'default'
    vi.stubGlobal('Notification', FakeNotification)
    vi.stubGlobal('isSecureContext', true)
    const { result } = renderHook(() => useNotificationsPrompt())
    expect(result.current.visible).toBe(true)
    await act(() => result.current.enable())
    expect(FakeNotification.requestPermission).toHaveBeenCalledOnce()
    expect(result.current.visible).toBe(false)
    expect(shown.map(item => item.title)).toEqual(['Notifications are on'])
  })

  it('stays in the app until you say its test appeared', async () => {
    const notify = vi.fn()
    vi.stubGlobal('hexbot', { notify })
    const { result, unmount } = renderHook(() => useNotificationsPrompt())
    expect(result.current).toMatchObject({ step: 'ask', visible: true })
    await act(() => result.current.enable())
    expect(notify).toHaveBeenCalledOnce()
    // The app cannot see whether its system showed it, so sending is not enough.
    expect(result.current).toMatchObject({ step: 'check', visible: true })
    unmount()
    const reopened = renderHook(() => useNotificationsPrompt())
    expect(reopened.result.current).toMatchObject({ step: 'ask', visible: true })
    await act(() => reopened.result.current.enable())
    act(() => reopened.result.current.confirm())
    expect(reopened.result.current.visible).toBe(false)
    expect(renderHook(() => useNotificationsPrompt()).result.current.visible).toBe(false)
  })

  it('leads a test that did not appear to another one', async () => {
    const notify = vi.fn()
    vi.stubGlobal('hexbot', { notify })
    const { result } = renderHook(() => useNotificationsPrompt())
    await act(() => result.current.enable())
    act(() => result.current.missing())
    expect(result.current).toMatchObject({ step: 'blocked', visible: true })
    await act(() => result.current.enable())
    expect(notify).toHaveBeenCalledTimes(2)
    expect(result.current.step).toBe('check')
  })

  it('asks the app again after an Enable from before it checked', () => {
    localStorage.setItem('hexbot.notifications.prompt', 'enabled')
    vi.stubGlobal('hexbot', { notify: vi.fn() })
    expect(renderHook(() => useNotificationsPrompt()).result.current.visible).toBe(true)
  })

  it('closes until Hexbot opens again, or for good from the menu', () => {
    vi.stubGlobal('hexbot', { notify: vi.fn() })
    const first = renderHook(() => useNotificationsPrompt())
    act(() => first.result.current.close())
    expect(first.result.current.visible).toBe(false)
    sessionStorage.clear()
    const reopened = renderHook(() => useNotificationsPrompt())
    expect(reopened.result.current.visible).toBe(true)
    act(() => reopened.result.current.never())
    sessionStorage.clear()
    expect(renderHook(() => useNotificationsPrompt()).result.current.visible).toBe(false)
  })

  it('does not ask a browser that blocked notifications or cannot have them', () => {
    FakeNotification.permission = 'denied'
    vi.stubGlobal('Notification', FakeNotification)
    expect(renderHook(() => useNotificationsPrompt()).result.current.visible).toBe(false)
  })
})

describe('systemNotificationSettings', () => {
  it.each([
    ['darwin', 'System Settings'],
    ['win32', 'Windows Settings']
  ])('opens them from the app on %s', (platform, name) => {
    const openNotificationSettings = vi.fn(async () => undefined)
    vi.stubGlobal('hexbot', { openNotificationSettings, platform })
    const settings = systemNotificationSettings()
    expect(settings?.name).toBe(name)
    settings?.open()
    expect(openNotificationSettings).toHaveBeenCalledOnce()
  })

  it('has none in a browser, on Linux, or in an app from before it could open them', () => {
    expect(systemNotificationSettings()).toBeNull()
    vi.stubGlobal('hexbot', { openNotificationSettings: vi.fn(), platform: 'linux' })
    expect(systemNotificationSettings()).toBeNull()
    vi.stubGlobal('hexbot', { platform: 'darwin' })
    expect(systemNotificationSettings()).toBeNull()
  })
})
