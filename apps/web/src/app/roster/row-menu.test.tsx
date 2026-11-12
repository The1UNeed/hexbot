import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { vi } from 'vitest'

import type { Bot, Room, RoomEvent } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useRooms } from '../../stores/rooms'

import { RosterColumn } from './index'

const navigate = vi.hoisted(() => vi.fn())
const params = vi.hoisted(() => ({ current: {} as Record<string, string> }))

const router = vi.hoisted(() => ({
  history: { location: {}, subscribe: () => () => undefined },
  subscribe: () => () => undefined
}))

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => router,
  useNavigate: () => navigate,
  useParams: () => params.current
}))

const markSection = vi.hoisted(() => vi.fn(() => Promise.resolve({})))

vi.mock('../../lib/api', async importOriginal => ({
  ...(await importOriginal<object>()),
  sectionsMarkRead: markSection
}))

const room = {
  approval_mode: null,
  archived_at: null,
  created_at: 0,
  id: 'garden',
  last_activity_at: 0,
  limits: {},
  main_bot: null,
  members: [{ last_read_seq: 1, left_at: null, member_id: 'local', member_kind: 'human' }],
  name: 'Garden',
  owner_id: 'local',
  pinned_at: null,
  updated_at: 0
} as unknown as Room

const bot = (patch: Partial<Bot>) =>
  ({
    description: '',
    display_name: 'Writer',
    last_activity_at: 0,
    name: 'writer',
    pinned_at: null,
    sections_recent: [],
    status: 'idle',
    title: '',
    ...patch
  }) as Bot

const event = { kind: 'message.bot', payload: { text: 'Done' }, seq: 4 } as unknown as RoomEvent

const pinRoom = vi.fn(() => Promise.resolve())
const markRoom = vi.fn(() => Promise.resolve())
const updateRoom = vi.fn(() => Promise.resolve())
const pinBot = vi.fn(() => Promise.resolve())
const updateBot = vi.fn(() => Promise.resolve(bot({})))

const menuFor = async (name: RegExp) => {
  fireEvent.contextMenu(screen.getByRole('button', { name }))

  return (await screen.findAllByRole('menuitem')).map(item => item.textContent)
}

describe('roster row menu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    params.current = {}
    useRooms.setState({
      byId: { [room.id]: room },
      eventsByRoom: { [room.id]: [event] },
      markRead: markRoom,
      order: [room.id],
      pin: pinRoom,
      update: updateRoom
    })
    useBots.setState({ byName: {}, order: [], pin: pinBot, update: updateBot })
  })

  it('offers pin, mark as read, rename and settings for a room', async () => {
    render(<RosterColumn />)

    expect(await menuFor(/Garden/)).toEqual(['Pin', 'Mark as read', 'Rename…', 'Settings'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin' }))
    expect(pinRoom).toHaveBeenCalledWith('garden', true)

    fireEvent.contextMenu(screen.getByRole('button', { name: /Garden/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Mark as read' }))
    expect(markRoom).toHaveBeenCalledWith('garden', 4)
  })

  it('shows a pinned room as a face above the list, and unpins it', async () => {
    useRooms.setState({ byId: { [room.id]: { ...room, pinned_at: 5 } } })
    render(<RosterColumn />)

    expect(
      within(screen.getByTestId('roster-pinned')).getByRole('button', { name: /Garden/ })
    ).toBeTruthy()
    await menuFor(/Garden/)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unpin' }))
    expect(pinRoom).toHaveBeenCalledWith('garden', false)
  })

  it('leaves Mark as read off when nothing is unread', async () => {
    useRooms.setState({ eventsByRoom: { [room.id]: [{ ...event, seq: 1 }] } })
    render(<RosterColumn />)

    await menuFor(/Garden/)
    expect(
      screen.getByRole('menuitem', { name: 'Mark as read' }).getAttribute('aria-disabled')
    ).toBe('true')
  })

  it('renames a room', async () => {
    render(<RosterColumn />)

    await menuFor(/Garden/)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }))
    const input = await screen.findByLabelText('Name')
    fireEvent.change(input, { target: { value: '  Greenhouse ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))

    await waitFor(() => expect(updateRoom).toHaveBeenCalledWith('garden', { name: 'Greenhouse' }))
    await waitFor(() => expect(screen.queryByLabelText('Name')).toBeNull())
  })

  it('closes Rename at once, and brings it back with the name when the daemon refuses it', async () => {
    let refuse!: (error: Error) => void
    updateRoom.mockImplementationOnce(() => new Promise<void>((_, no) => (refuse = no)) as never)
    render(<RosterColumn />)

    await menuFor(/Garden/)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }))
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Greenhouse' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(screen.queryByLabelText('Name')).toBeNull())

    refuse(new Error('That name is taken'))
    expect(await screen.findByLabelText('Name')).toHaveValue('Greenhouse')
    expect(screen.getByRole('alert')).toHaveTextContent('That name is taken')
  })

  it('renames a bot by its display name and marks its finished chat read', async () => {
    const chat = {
      archived_at: null,
      bot: 'writer',
      done_at: 3,
      id: 'chat-1',
      preview: '',
      purpose: null
    }

    const writer = bot({ sections_recent: [chat] as Bot['sections_recent'] })
    useRooms.setState({ byId: {}, order: [] })
    useBots.setState({ byName: { writer }, order: ['writer'] })
    render(<RosterColumn />)

    expect(await menuFor(/Writer/)).toEqual(['Pin', 'Mark as read', 'Rename…', 'Settings'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark as read' }))
    expect(markSection).toHaveBeenCalledWith('chat-1')
    // The dot clears without waiting for the daemon's next list.
    expect(useBots.getState().byName.writer!.sections_recent[0]!.done_at).toBeNull()

    await menuFor(/Writer/)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }))
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Scribe' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))

    await waitFor(() =>
      expect(updateBot).toHaveBeenCalledWith('writer', { display_name: 'Scribe' })
    )
  })

  it('asks once to mark the open chat read when the daemon refuses', async () => {
    const chat = {
      archived_at: null,
      bot: 'writer',
      done_at: 3,
      id: 'chat-1',
      preview: '',
      purpose: null
    }

    params.current = { bot: 'writer', section: 'chat-1' }
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    markSection.mockImplementation(() => Promise.reject(new Error('Refused')))
    useRooms.setState({ byId: {}, order: [] })
    useBots.setState({
      byName: { writer: bot({ sections_recent: [chat] as Bot['sections_recent'] }) },
      order: ['writer']
    })
    render(<RosterColumn />)

    // The refusal puts the dot back; that must not ask again.
    await waitFor(() =>
      expect(useBots.getState().byName.writer!.sections_recent[0]!.done_at).toBe(3)
    )
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(markSection).toHaveBeenCalledTimes(1)
  })

  it('pins the primary bot by default and lets you unpin it', async () => {
    const primary = bot({ display_name: 'HexBot', name: 'hexbot', pinned_at: 1, primary: true })
    useRooms.setState({ byId: {}, order: [] })
    useBots.setState({ byName: { hexbot: primary }, order: ['hexbot'] })
    render(<RosterColumn />)

    expect(within(screen.getByTestId('roster-pinned')).getByText('HexBot')).toBeTruthy()
    expect(await menuFor(/HexBot/)).toEqual(['Unpin', 'Mark as read', 'Rename…', 'Settings'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unpin' }))
    expect(pinBot).toHaveBeenCalledWith('hexbot', false)
  })

  it('offers no Pin on a daemon from before pins, which keeps the primary bot on top', async () => {
    const primary = bot({ display_name: 'HexBot', name: 'hexbot', primary: true })
    delete (primary as Partial<Bot>).pinned_at
    useRooms.setState({ byId: {}, order: [] })
    useBots.setState({ byName: { hexbot: primary }, order: ['hexbot'] })
    render(<RosterColumn />)

    expect(within(screen.getByTestId('roster-pinned')).getByText('HexBot')).toBeTruthy()
    expect(await menuFor(/HexBot/)).toEqual(['Mark as read', 'Rename…', 'Settings'])
  })

  it('lists pinned bots as rows while you search', () => {
    const primary = bot({ display_name: 'HexBot', name: 'hexbot', pinned_at: 1, primary: true })
    useRooms.setState({ byId: {}, order: [] })
    useBots.setState({ byName: { hexbot: primary }, order: ['hexbot'] })
    render(<RosterColumn />)

    fireEvent.change(screen.getByLabelText('Search bots and rooms'), { target: { value: 'hex' } })
    expect(screen.queryByTestId('roster-pinned')).toBeNull()
    expect(screen.getByRole('button', { name: /HexBot/ })).toBeTruthy()
  })
})
