import { afterEach, describe, expect, it, vi } from 'vitest'

import { NOTIFY_BODY, notifyUser, OPEN_SECTION_EVENT } from './notify'

const shown: { body?: string; onclick: null | (() => void); title: string }[] = []

class FakeNotification {
  static permission: NotificationPermission = 'granted'
  onclick: null | (() => void) = null
  constructor(
    public title: string,
    options: { body?: string } = {}
  ) {
    shown.push(Object.assign(this, { body: options.body }))
  }
}

afterEach(() => {
  shown.length = 0
  FakeNotification.permission = 'granted'
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('notifyUser', () => {
  it('shortens a long reply to what the app accepts', () => {
    const notify = vi.fn()
    vi.stubGlobal('hexbot', { notify })
    notifyUser({ backgroundOnly: true, body: 'x'.repeat(2_500), sectionId: 'chat', title: 'Owl' })
    const sent = notify.mock.calls[0]![0] as { backgroundOnly: boolean; body: string }
    expect(sent.body).toHaveLength(NOTIFY_BODY)
    expect(sent.body.endsWith('…')).toBe(true)
    expect(sent.backgroundOnly).toBe(true)
  })

  it('swallows a notification the app refuses', async () => {
    const refused = Promise.reject(new TypeError('Invalid body'))
    vi.stubGlobal('hexbot', { notify: () => refused })
    notifyUser({ body: 'Done.', title: 'Owl' })
    await expect(refused).rejects.toThrow('Invalid body')
  })

  it('shows a browser notification only in the background, and a click opens the chat', () => {
    vi.stubGlobal('Notification', FakeNotification)
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    notifyUser({ body: 'Done.', sectionId: 'chat', title: 'Owl' })
    expect(shown).toHaveLength(0)
    hidden.mockReturnValue(true)
    notifyUser({ body: 'Done.', sectionId: 'chat', title: 'Owl' })
    expect(shown).toMatchObject([{ body: 'Done.', title: 'Owl' }])
    const opened = vi.fn()
    window.addEventListener(OPEN_SECTION_EVENT, opened)
    shown[0]!.onclick!()
    window.removeEventListener(OPEN_SECTION_EVENT, opened)
    expect((opened.mock.calls[0]![0] as CustomEvent<string>).detail).toBe('chat')
  })

  it('shows nothing in a browser that has not allowed notifications', () => {
    FakeNotification.permission = 'default'
    vi.stubGlobal('Notification', FakeNotification)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    notifyUser({ body: 'Done.', title: 'Owl' })
    expect(shown).toHaveLength(0)
  })
})
