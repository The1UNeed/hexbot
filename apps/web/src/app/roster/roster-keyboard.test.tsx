import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { vi } from 'vitest'

import { sectionShown } from '../../lib/page-visible'
import { setActiveRpc } from '../../lib/rpc'
import type { Bot, Room, Section } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useMe } from '../../stores/me'
import { useRooms } from '../../stores/rooms'
import { liveSectionsOf, useSections } from '../../stores/sections'
import { useSettings } from '../../stores/settings'
import { useUi } from '../../stores/ui'
import { botRowState } from '../bot-mood'

import { RosterColumn } from './index'

const navigate = vi.hoisted(() => vi.fn())

const routeParams = vi.hoisted(() => ({
  current: {} as { bot?: string; room?: string; section?: string }
}))

const router = vi.hoisted(() => ({
  history: { location: {}, subscribe: () => () => undefined },
  subscribe: () => () => undefined
}))

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => router,
  useNavigate: () => navigate,
  useParams: () => routeParams.current
}))

const room = {
  approval_mode: null,
  archived_at: null,
  created_at: 0,
  id: 'garden',
  last_activity_at: 0,
  limits: {},
  main_bot: null,
  members: [],
  name: 'Garden',
  owner_id: 'local',
  updated_at: 0
} as unknown as Room

describe('RosterColumn keyboard', () => {
  beforeEach(() => {
    navigate.mockClear()
    useRooms.setState({ byId: { [room.id]: room }, order: [room.id] })
  })

  it('opens the focused row from the search box', () => {
    render(<RosterColumn />)
    const search = screen.getByLabelText('Search bots and rooms')

    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(navigate).toHaveBeenCalledWith({ params: { room: 'garden' }, to: '/r/$room' })
  })

  it('leaves Enter in a context menu to the menu', async () => {
    render(<RosterColumn />)
    const row = screen.getByRole('button', { name: /Garden/ })

    // Arrow keys focus the room row, so Enter there would open the room.
    fireEvent.keyDown(row, { key: 'ArrowDown' })
    fireEvent.contextMenu(row)
    fireEvent.keyDown(await screen.findByRole('menuitem', { name: 'Settings' }), { key: 'Enter' })

    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(navigate).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith({ params: { room: 'garden' }, to: '/r/$room/settings' })
  })

  it('leaves Enter on other sidebar buttons to the button', () => {
    render(<RosterColumn />)

    fireEvent.keyDown(screen.getByRole('button', { name: /Garden/ }), { key: 'ArrowDown' })
    const event = fireEvent.keyDown(screen.getByRole('button', { name: 'New' }), { key: 'Enter' })

    expect(event).toBe(true)
    expect(navigate).not.toHaveBeenCalled()
  })
})

describe('new room approvals on older daemons', () => {
  it.each([
    ['member', 'smart', false],
    ['member', 'off', true],
    ['admin', 'smart', true],
    [undefined, 'smart', true]
  ] as const)('role %s, mode %s offers Bypass: %s', async (role, approval_mode, bypass) => {
    useMe.setState({ me: { display_name: 'Alex', id: 'local', role } })
    useBots.setState({
      order: ['scout'],
      byName: {
        scout: {
          avatar: null,
          display_name: 'Scout',
          name: 'scout',
          title: '',
          sections_recent: []
        } as unknown as Bot
      }
    })
    useSettings.setState({
      settings: {
        approval_mode,
        billing_notice_ack: false,
        dream_enabled: true,
        dream_time: '03:00',
        lan_enabled: false,
        service_installed: false,
        workspace_dir: ''
      }
    })
    render(<RosterColumn />)
    fireEvent.click(screen.getByRole('button', { name: 'New' }))
    const newRoom = await screen.findByRole('menuitem', { name: 'New room' })
    fireEvent.mouseMove(newRoom)
    fireEvent.click(newRoom)
    const picker = await screen.findByRole('combobox', { name: 'Room approval mode' })
    fireEvent.click(picker)
    expect(await screen.findByRole('option', { name: 'Auto' })).toBeVisible()
    expect(screen.queryByRole('option', { name: 'Bypass' }) !== null).toBe(bypass)

    if (approval_mode === 'off') {
      expect(picker).toHaveTextContent('Bypass')
    }
  })
})

describe('one chat per bot', () => {
  const scout = {
    avatar: null,
    description: 'Finds things',
    display_name: 'Scout',
    name: 'scout',
    sections_recent: [],
    title: ''
  } as unknown as Bot

  const chat = {
    archived_at: null,
    bot: 'scout',
    done_at: null,
    id: 'chat',
    message_count: 3,
    peer_bot: null,
    preview: 'Hi',
    title: 'General'
  } as unknown as Section

  const named = vi.fn((bot: string) =>
    Promise.resolve(bot === 'scout' ? ({ ...chat, id: 'named' } as Section) : null)
  )

  beforeEach(() => {
    navigate.mockClear()
    named.mockClear()
    useRooms.setState({ byId: {}, order: [] })
    useBots.setState({ byName: { scout }, loaded: true, order: ['scout'] })
    useSections.setState({
      byId: { chat },
      chat: named,
      idsByBot: { scout: ['chat'] },
      open: () => new Promise(() => undefined)
    })
  })

  it('lists a bot once, without its sections, and opens the chat the daemon names', async () => {
    render(<RosterColumn />)

    expect(screen.getAllByRole('button', { name: /Scout/ })).toHaveLength(1)
    expect(screen.queryByText('General')).toBeNull()

    // The one this window knows may be a chat recovery set aside.
    fireEvent.click(screen.getByRole('button', { name: /Scout/ }))

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        params: { bot: 'scout', section: 'named' },
        to: '/b/$bot/s/$section'
      })
    )
    expect(named).toHaveBeenCalledWith('scout', expect.any(Function))
  })

  it('marks a bot done only for its chat, not Check-ins or an archived section', async () => {
    const finished = (extra: Partial<Section>) =>
      ({ ...chat, done_at: 5, ...extra }) as unknown as Section

    for (const [sections, done] of [
      [[finished({ id: 'checkins', purpose: 'checkins' })], false],
      [[finished({ id: 'old', archived_at: 4 })], false],
      [[finished({})], true]
    ] as const) {
      useSections.setState({
        byId: Object.fromEntries(sections.map(s => [s.id, s])),
        idsByBot: { scout: sections.map(s => s.id) }
      })
      const view = render(<RosterColumn />)
      expect(screen.queryByLabelText('Done') !== null).toBe(done)
      view.unmount()
    }
  })

  it('opens nothing when the user picks no section on an older daemon', async () => {
    named.mockResolvedValueOnce(null)
    render(<RosterColumn />)

    fireEvent.click(screen.getByRole('button', { name: /Scout/ }))

    await waitFor(() => expect(named).toHaveBeenCalledWith('scout', expect.any(Function)))
    expect(navigate).not.toHaveBeenCalled()
  })

  it('offers a new bot and a new room, not a new section', async () => {
    render(<RosterColumn />)
    fireEvent.click(screen.getByRole('button', { name: 'New' }))

    expect(await screen.findByRole('menuitem', { name: 'New bot' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: 'New room' })).toBeVisible()
    expect(screen.queryByRole('menuitem', { name: 'New section' })).toBeNull()
  })

  it('keeps a covered chat unread while a peer thread is open, and opens waiting threads in ThreadView', async () => {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const call = vi.fn(() => Promise.resolve({}))
    setActiveRpc({ call } as never)
    routeParams.current = { bot: 'scout', section: 'chat' }
    useUi.setState({ thread: { bot: 'writer', peer: 'scout', sectionId: 'th1' } })

    const waitingWriter = {
      avatar: null,
      description: 'Writes',
      display_name: 'Writer',
      name: 'writer',
      sections_recent: [],
      status: 'needs_you',
      status_detail: {
        action: null,
        peer_bot: 'scout',
        room_id: null,
        section_id: 'th-wait',
        session_id: 'live-wait',
        since: 1,
        text: 'Waiting for you'
      },
      title: ''
    } as unknown as Bot

    useBots.setState({
      byName: { scout, writer: waitingWriter },
      loaded: true,
      order: ['scout', 'writer']
    })
    useSections.setState({
      byId: { chat: { ...chat, done_at: 99 } },
      idsByBot: { scout: ['chat'] }
    })

    try {
      render(<RosterColumn />)
      // Covered chat is neither marked read nor considered shown for notifications.
      expect(call).not.toHaveBeenCalledWith('hexbot.sections.mark_read', expect.anything())
      expect(sectionShown('chat')).toBe(false)
      expect(sectionShown('th1')).toBe(true)
      expect(screen.getByLabelText('Done')).toBeInTheDocument()

      // Clicking Review opens the waiting thread in ThreadView rather than bypassing via route navigation.
      fireEvent.click(screen.getByRole('button', { name: /Writer is waiting for you/ }))
      expect(useUi.getState().thread).toEqual({
        bot: 'writer',
        peer: 'scout',
        sectionId: 'th-wait'
      })
      expect(navigate).not.toHaveBeenCalled()

      // Closing the thread brings the covered chat into view and marks it read.
      act(() => useUi.getState().closeThread())
      await waitFor(() =>
        expect(call).toHaveBeenCalledWith('hexbot.sections.mark_read', { id: 'chat' })
      )
      expect(sectionShown('chat')).toBe(true)
    } finally {
      focus.mockRestore()
      routeParams.current = {}
      useUi.setState({ thread: null })
    }
  })

  it('keeps a bot row idle while only a peer thread streams in live transcripts', () => {
    const live = liveSectionsOf({
      'live-peer': {
        approvals: [],
        clarifies: [],
        sectionId: 'th1',
        streamingMessageId: 'm1'
      }
    })

    const state = botRowState(scout, [chat], live, {}, false, undefined)
    expect(state.status).toBe('idle')
    expect(state.dot).toBe('idle')
  })

  it('keeps the receiving bot unread dot visible when viewing a direct peer thread URL', () => {
    routeParams.current = { bot: 'scout', section: 'th1' }
    useUi.setState({ peerRoute: 'th1', thread: null })
    useBots.setState({
      byName: { scout },
      loaded: true,
      order: ['scout']
    })
    useSections.setState({
      byId: { chat: { ...chat, done_at: 99 } },
      idsByBot: { scout: ['chat'] }
    })

    try {
      render(<RosterColumn />)
      expect(screen.getByLabelText('Done')).toBeInTheDocument()
    } finally {
      routeParams.current = {}
      useUi.setState({ peerRoute: null, thread: null })
    }
  })
})
