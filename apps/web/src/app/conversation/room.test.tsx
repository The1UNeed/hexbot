import type { GatewayEvent } from '@hermes/shared'
import { JsonRpcGatewayError } from '@hermes/shared'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { routeEvent } from '../../lib/events'
import { setActiveRpc } from '../../lib/rpc'
import type { Bot, Room, RoomMember } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useRooms } from '../../stores/rooms'
import {
  resetTranscriptEffects,
  setTranscriptEffects,
  useTranscripts
} from '../../stores/transcripts'
import { useUi } from '../../stores/ui'
import { useUsers } from '../../stores/users'

import { RoomConversation, RoomEventRow, RoomMentionPopover } from './room'

const navigate = vi.fn()

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useParams: () => ({ room: 'r1' })
}))

describe('room composer mentions', () => {
  it('names bot suggestions from member rows without access to their profiles', () => {
    render(
      <RoomMentionPopover
        bots={{}}
        members={[
          { display_name: 'Writer', member_id: 'writer', member_kind: 'bot' } as RoomMember
        ]}
        onSelect={vi.fn()}
        query="wri"
      />
    )
    expect(screen.getByRole('button', { name: '@writer Writer' })).toBeVisible()
  })
  it('lists bot members, filters by the typed handle, and never offers user', () => {
    const select = vi.fn()

    const members = [
      { member_id: 'writer', member_kind: 'bot' },
      { member_id: 'planner', member_kind: 'bot' }
    ] as RoomMember[]

    const bots = {
      planner: { display_name: 'Planner' } as Bot,
      writer: { display_name: 'Writer' } as Bot
    }

    render(<RoomMentionPopover bots={bots} members={members} onSelect={select} query="wri" />)
    expect(screen.getByRole('button', { name: /@writer/ })).toBeVisible()
    expect(screen.queryByText('@user')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /@writer/ }))
    expect(select).toHaveBeenCalledWith('writer')
  })
})

describe('a room you can no longer see', () => {
  it('leaves for home once loading finds it gone, instead of loading forever', async () => {
    Element.prototype.scrollIntoView = vi.fn()
    useRooms.setState({
      byId: { r1: { id: 'r1', members: [], name: 'Lab' } as unknown as Room },
      eventsByRoom: {},
      liveTurnsByRoom: {},
      order: ['r1']
    })
    setActiveRpc({
      call: vi.fn(() =>
        Promise.reject(new JsonRpcGatewayError('not a room member', { code: 4302 }))
      )
    } as never)
    render(<RoomConversation />)
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/' }))
    expect(useRooms.getState().byId.r1).toBeUndefined()
  })
})

describe('reading a room', () => {
  it('marks the latest message read once, not on every stored room', async () => {
    Element.prototype.scrollIntoView = vi.fn()
    const room = { id: 'r1', members: [], name: 'Lab', owner_id: 'local' } as unknown as Room

    const events = [
      {
        actor_id: 'local',
        actor_kind: 'human',
        created_at: 1,
        kind: 'message.user',
        payload: { text: 'hi' },
        room_id: 'r1',
        seq: 1
      }
    ]

    useRooms.setState({ byId: { r1: room }, eventsByRoom: {}, liveTurnsByRoom: {}, order: ['r1'] })

    let marks = 0

    const call = vi.fn((method: string) =>
      method === 'hexbot.rooms.mark_read' && ++marks > 3
        ? // A loop would never end; stop answering so the count shows it.
          new Promise(() => {})
        : Promise.resolve(
            method === 'hexbot.rooms.log'
              ? { events }
              : // Each reply is a fresh room object, as from the daemon.
                { room: { ...room } }
          )
    )

    setActiveRpc({ call } as never)
    render(<RoomConversation />)
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.rooms.mark_read', { id: 'r1', seq: 1 })
    )

    for (let flush = 0; flush < 20; flush++) {
      await act(async () => {})
    }

    expect(marks).toBeLessThanOrEqual(2)
  })
})

describe('approvals and questions in a room', () => {
  const room = { id: 'r1', members: [], name: 'Lab', owner_id: 'alice' } as unknown as Room
  const turn = { bot: 'owl', live_session_id: 'live-1', room_id: 'r1', status: 'running' }

  const approval = (id: string) =>
    ({
      payload: { command: 'rm -rf build', reason: 'Run command', request_id: id },
      session_id: 'live-1',
      type: 'approval.request'
    }) as GatewayEvent

  let call: ReturnType<typeof vi.fn>

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
    setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
    useTranscripts.setState({ bySession: {} })
    useRooms.setState({
      byId: { r1: room },
      eventsByRoom: {},
      liveTurnsByRoom: {},
      order: ['r1']
    })
    useRooms.getState().handleTurn(turn)
    call = vi.fn((method: string) =>
      Promise.resolve(
        method === 'hexbot.rooms.log'
          ? { events: [] }
          : method === 'approval.respond'
            ? { resolved: true }
            : method === 'clarify.respond'
              ? { status: 'answered' }
              : { room }
      )
    )
    setActiveRpc({ call } as never)
  })
  afterEach(resetTranscriptEffects)

  it.each([
    ['Approve', 'once'],
    ['Always allow', 'always'],
    ['Deny', 'deny']
  ])(
    'shows the owner the card on the live turn; %s answers it and it goes',
    async (label, choice) => {
      render(<RoomConversation />)
      act(() => routeEvent(approval('ap-1')))
      expect(await screen.findByText('Approval needed')).toBeVisible()
      expect(screen.getByText('rm -rf build')).toBeVisible()
      // A replay of the same request (reconnect, reopening the room) shows one card.
      act(() => routeEvent(approval('ap-1')))
      expect(screen.getAllByText('Approval needed')).toHaveLength(1)
      fireEvent.click(screen.getByRole('button', { name: label }))
      await waitFor(() => expect(screen.queryByText('Approval needed')).not.toBeInTheDocument())
      expect(call).toHaveBeenCalledWith('approval.respond', {
        choice,
        request_id: 'ap-1',
        session_id: 'live-1'
      })
    }
  )

  it('drops an open card when the turn ends, so the next turn starts clean', async () => {
    render(<RoomConversation />)
    act(() => routeEvent(approval('ap-2')))
    expect(await screen.findByText('Approval needed')).toBeVisible()
    act(() => useRooms.getState().handleTurn({ ...turn, status: 'failed' }))
    expect(screen.queryByText('Approval needed')).not.toBeInTheDocument()
    act(() => useRooms.getState().handleTurn(turn))
    expect(screen.queryByText('Approval needed')).not.toBeInTheDocument()
  })

  it('shows a question until it is answered or expires', async () => {
    render(<RoomConversation />)

    const ask = (id: string) =>
      act(() =>
        routeEvent({
          payload: { choices: ['Red', 'Blue'], question: 'Which color?', request_id: id },
          session_id: 'live-1',
          type: 'clarify.request'
        } as GatewayEvent)
      )

    ask('q-1')
    fireEvent.click(await screen.findByRole('option', { name: /Blue/ }))
    await waitFor(() => expect(screen.queryByText('Which color?')).not.toBeInTheDocument())
    expect(call).toHaveBeenCalledWith(
      'clarify.respond',
      expect.objectContaining({ answer: 'Blue', request_id: 'q-1', session_id: 'live-1' })
    )
    ask('q-2')
    expect(await screen.findByText('Which color?')).toBeVisible()
    act(() =>
      routeEvent({
        payload: { request_id: 'q-2' },
        session_id: 'live-1',
        type: 'clarify.expire'
      } as GatewayEvent)
    )
    expect(screen.queryByText('Which color?')).not.toBeInTheDocument()
  })

  it('restores a member wait notice after reload, even when replay precedes hydration', async () => {
    const reloaded = {
      ...room,
      members: [{ display_name: 'Owl', member_id: 'owl', member_kind: 'bot' }],
      turns: [{ bot: 'owl', live_session_id: 'live-1' }]
    } as unknown as Room

    useUsers.setState({ current: { display_name: 'Bob', id: 'bob', role: 'member' }, users: [] })
    useBots.setState({ byName: {} })
    useTranscripts.setState({ bySession: {} })
    useRooms.setState({ byId: {}, eventsByRoom: {}, liveTurnsByRoom: {}, order: [] })
    let finishList!: (value: { rooms: Room[] }) => void

    const list = new Promise<{ rooms: Room[] }>(resolve => {
      finishList = resolve
    })

    call.mockImplementation((method: string) => {
      if (method === 'hexbot.rooms.list') {
        return list
      }

      if (method === 'hexbot.rooms.get') {
        routeEvent({
          payload: { kind: 'waiting', text: 'Waiting for Alice' },
          session_id: 'live-1',
          type: 'status.update'
        } as GatewayEvent)
      }

      return Promise.resolve(method === 'hexbot.rooms.log' ? { events: [] } : { room: reloaded })
    })
    const refresh = useRooms.getState().refresh()
    render(<RoomConversation />)
    await waitFor(() => expect(call).toHaveBeenCalledWith('hexbot.rooms.get', { id: 'r1' }))
    await act(async () => {
      finishList({ rooms: [reloaded] })
      await refresh
    })
    expect(await screen.findByText('Waiting for Alice')).toBeVisible()
    expect(screen.getByRole('status', { name: 'Owl is working' })).toBeVisible()
    expect(screen.queryByText('Approval needed')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    act(() =>
      routeEvent({
        payload: { kind: 'working', text: 'Working' },
        session_id: 'live-1',
        type: 'status.update'
      } as GatewayEvent)
    )
    expect(screen.queryByText('Waiting for Alice')).not.toBeInTheDocument()
  })

  it('shows a member only whom the bot waits for', async () => {
    render(<RoomConversation />)
    // What the daemon sends a member in place of the card.
    act(() =>
      routeEvent({
        payload: { kind: 'waiting', text: 'Waiting for Alice' },
        session_id: 'live-1',
        type: 'status.update'
      } as GatewayEvent)
    )
    expect(await screen.findByText('Waiting for Alice')).toBeVisible()
    expect(screen.queryByText('Approval needed')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  })
})

describe('room history', () => {
  it('keeps the teammates a bot asked with its reply, and opens their conversation', () => {
    useBots.setState({
      byName: {
        owl: { avatar: null, display_name: 'Owl', name: 'owl' } as unknown as Bot,
        writer: { avatar: null, display_name: 'Writer', name: 'writer' } as unknown as Bot
      }
    })
    render(
      <RoomEventRow
        event={
          {
            actor_id: 'owl',
            actor_kind: 'bot',
            kind: 'message.bot',
            payload: { asks: [{ section_id: 'th1', to: 'writer' }], text: 'Writer helped.' },
            room_id: 'r1',
            seq: 3
          } as never
        }
      />
    )
    expect(screen.getByText('Writer helped.')).toBeVisible()
    fireEvent.click(
      screen.getByRole('button', { name: 'Open the conversation between Owl and Writer' })
    )
    expect(useUi.getState().thread).toEqual({ bot: 'writer', peer: 'owl', sectionId: 'th1' })
  })
})
