import type { GatewayEvent } from '@hermes/shared'
import { JsonRpcGatewayError } from '@hermes/shared'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { routeEvent } from '../../lib/events'
import { setActiveRpc } from '../../lib/rpc'
import * as sounds from '../../lib/sounds'
import type { Bot, Room, RoomEvent, RoomMember } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useMe } from '../../stores/me'
import { useRooms } from '../../stores/rooms'
import {
  resetTranscriptEffects,
  setTranscriptEffects,
  useTranscripts
} from '../../stores/transcripts'
import { useUi } from '../../stores/ui'

import { RoomConversation, RoomEventRow, RoomMentionPopover } from './room'
import { SEND_TIMEOUT_MS } from './unsent'

const navigate = vi.fn()
let roomId = 'r1'
beforeEach(() => {
  roomId = 'r1'
})

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useParams: () => ({ room: roomId })
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

  it('does not mark a room read while a clicked bot opens in front of it', async () => {
    Element.prototype.scrollIntoView = vi.fn()
    const room = { id: 'r1', members: [], name: 'Lab', owner_id: 'local' } as unknown as Room

    const message = (seq: number) =>
      ({
        actor_id: 'local',
        actor_kind: 'human',
        created_at: seq,
        kind: 'message.user',
        payload: { text: `hi ${seq}` },
        room_id: 'r1',
        seq
      }) as RoomEvent

    useRooms.setState({ byId: { r1: room }, eventsByRoom: {}, liveTurnsByRoom: {}, order: ['r1'] })

    const call = vi.fn((method: string) =>
      Promise.resolve(method === 'hexbot.rooms.log' ? { events: [message(1)] } : { room: { ...room } })
    )

    setActiveRpc({ call } as never)
    render(<RoomConversation />)
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.rooms.mark_read', { id: 'r1', seq: 1 })
    )

    // A bot is clicked; a message arrives in the room behind its loading face.
    await act(async () => useUi.setState({ openingBot: 'owl' }))
    await act(async () =>
      useRooms.setState(state => ({
        eventsByRoom: { ...state.eventsByRoom, r1: [...(state.eventsByRoom.r1 ?? []), message(2)] }
      }))
    )

    for (let flush = 0; flush < 10; flush++) {
      await act(async () => {})
    }

    expect(call).not.toHaveBeenCalledWith('hexbot.rooms.mark_read', { id: 'r1', seq: 2 })

    // The click came to nothing: the room is back in view, and read.
    await act(async () => useUi.setState({ openingBot: null }))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.rooms.mark_read', { id: 'r1', seq: 2 })
    )
  })
})

describe('approvals and questions in a room', () => {
  const room = { id: 'r1', members: [], name: 'Lab', owner_id: 'alice' } as unknown as Room
  const turn = { bot: 'owl', live_session_id: 'live-1', room_id: 'r1', status: 'running' }

  const approval = (id: string) =>
    ({
      payload: {
        choices: ['once', 'session', 'deny'],
        command: 'rm -rf build',
        reason: 'Run command',
        request_id: id
      },
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

  it('includes live pending approvals and partially answered questions in sound cues', async () => {
    const cues = vi.spyOn(sounds, 'useTurnCues')
    render(<RoomConversation />)
    act(() => routeEvent(approval('sound-approval')))
    await waitFor(() =>
      expect(cues).toHaveBeenLastCalledWith('r1', expect.objectContaining({ waiting: 1 }))
    )
    act(() =>
      useTranscripts.getState().clarifyRequest('live-1', {
        request_id: 'sound-question',
        questions: [
          { qid: 'one', question: 'First?', choices: ['Yes', 'No'] },
          { qid: 'two', question: 'Second?', choices: ['Yes', 'No'] }
        ],
        answers: { one: 'Yes' }
      })
    )
    expect(cues).toHaveBeenLastCalledWith('r1', expect.objectContaining({ waiting: 2 }))
    act(() => useTranscripts.getState().clarifyExpire('live-1', 'sound-question'))
    expect(cues).toHaveBeenLastCalledWith('r1', expect.objectContaining({ waiting: 1 }))
    cues.mockRestore()
  })

  it.each([
    ['Approve', 'once'],
    ['Allow for now', 'session'],
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

  it('keeps the bot working after a card while another review still runs', async () => {
    const event = (type: string, payload: Record<string, unknown>) =>
      ({ payload, session_id: 'live-1', type }) as GatewayEvent

    render(<RoomConversation />)
    act(() => {
      routeEvent(event('message.start', {}))
      routeEvent(event('tool.start', { name: 'terminal', tool_id: 'a' }))
      routeEvent(event('tool.start', { name: 'terminal', tool_id: 'b' }))
      routeEvent(event('status.update', { kind: 'checking', text: 'Checking this step' }))
      routeEvent(approval('a'))
    })
    expect(await screen.findByText('Approval needed')).toBeVisible()
    expect(useTranscripts.getState().bySession['live-1']?.streamingMessageId).toBeNull()
    expect(screen.getByRole('status', { name: /is working$/ })).toBeVisible()
    expect(screen.queryByText('Checking this step')).toBeNull()
    act(() => {
      routeEvent(event('status.update', { kind: 'checking', text: '' }))
      routeEvent(event('tool.complete', { result: 'ok', tool_id: 'a' }))
      routeEvent(event('tool.complete', { result: 'ok', tool_id: 'b' }))
    })
    expect(screen.queryByRole('status', { name: /is working$/ })).toBeNull()
  })

  it('cues a failed turn as failed, though its failure event comes after it ends', () => {
    const cues = vi.spyOn(sounds, 'useTurnCues')
    render(<RoomConversation />)
    act(() => useRooms.getState().handleTurn({ ...turn, status: 'failed' }))
    expect(cues).toHaveBeenLastCalledWith(
      'r1',
      expect.objectContaining({ failed: true, streaming: false })
    )
    cues.mockRestore()
  })

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

    useMe.setState({ me: { display_name: 'Bob', id: 'bob' } })
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
  it('prefers your renamed identity over stale room member names', () => {
    useMe.setState({ me: { display_name: 'Alex', id: 'local' } })
    useRooms.setState({
      byId: {
        r1: {
          id: 'r1',
          members: [{ member_kind: 'human', member_id: 'local', display_name: 'Admin' }]
        } as Room
      }
    })
    render(
      <RoomEventRow
        event={
          {
            actor_id: 'local',
            actor_kind: 'human',
            kind: 'member.added',
            payload: { member_id: 'local', member_kind: 'human' },
            room_id: 'r1',
            seq: 1
          } as never
        }
      />
    )
    expect(screen.getByText(/Alex/)).toBeVisible()
    expect(screen.queryByText(/Admin/)).toBeNull()
  })

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

describe('room history window', () => {
  it('starts with 60 events, anchors earlier history, keeps live events and resets on navigation', async () => {
    const room = { id: 'r1', name: 'Lab', members: [] } as unknown as Room

    const events = Array.from({ length: 1000 }, (_, i) => ({
      room_id: 'r1',
      seq: i + 1,
      actor_kind: 'human',
      kind: 'message.user',
      created_at: 0,
      payload: { text: `Event ${i + 1}` }
    })) as RoomEvent[]

    useRooms.setState({
      byId: { r1: room, r2: { ...room, id: 'r2' } },
      eventsByRoom: { r1: events, r2: events },
      liveTurnsByRoom: {}
    })
    setActiveRpc({
      call: vi.fn((method: string, input: { id: string }) =>
        Promise.resolve(
          method === 'hexbot.rooms.log' ? { events } : { room: { ...room, id: input.id } }
        )
      )
    } as never)
    const view = render(<RoomConversation />)
    await waitFor(() => expect(screen.getAllByTestId('room-event')).toHaveLength(60))
    const viewport = screen.getByText('Event 1000').closest('.overflow-y-auto') as HTMLDivElement
    Object.defineProperty(viewport, 'scrollHeight', {
      configurable: true,
      get: () => screen.getAllByTestId('room-event').length * 20
    })
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 400 })
    viewport.scrollTop = 100
    fireEvent.scroll(viewport)
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))
    expect(screen.getAllByTestId('room-event')).toHaveLength(120)
    expect(viewport.scrollTop).toBe(1300)
    act(() =>
      useRooms.setState({
        eventsByRoom: {
          r1: [...events, { ...events[999]!, seq: 1001, payload: { text: 'Live event' } }],
          r2: events
        }
      })
    )
    expect(screen.getByText('Live event')).toBeVisible()
    expect(screen.getByText('Event 881')).toBeVisible()
    expect(viewport.scrollTop).toBe(1300)
    expect(scroll).not.toHaveBeenCalled()
    roomId = 'r2'
    view.rerender(<RoomConversation />)
    await waitFor(() => expect(screen.getAllByTestId('room-event')).toHaveLength(60))
    scroll.mockRestore()
  })
})

describe('room history window after a live event', () => {
  it('keeps the first shown event once history arrives behind it', () => {
    const room = { id: 'r1', name: 'Lab', members: [] } as unknown as Room

    const event = (seq: number) =>
      ({
        room_id: 'r1',
        seq,
        actor_kind: 'human',
        kind: 'message.user',
        created_at: 0,
        payload: { text: `Event ${seq}` }
      }) as RoomEvent

    const history = Array.from({ length: 1001 }, (_, i) => event(i + 1))
    useRooms.setState({
      byId: { r1: room },
      eventsByRoom: { r1: [event(1001)] },
      liveTurnsByRoom: {}
    })
    setActiveRpc({ call: vi.fn(() => new Promise(() => {})) } as never)
    render(<RoomConversation />)
    act(() => useRooms.setState({ eventsByRoom: { r1: history } }))
    expect(screen.getAllByTestId('room-event')).toHaveLength(60)
    act(() => useRooms.setState({ eventsByRoom: { r1: [...history, event(1002)] } }))
    expect(screen.getAllByTestId('room-event')).toHaveLength(61)
    expect(screen.getByText('Event 942')).toBeVisible()
  })
})

describe('sending in a room', () => {
  const room = { id: 'r1', members: [], name: 'Lab', owner_id: 'local' } as unknown as Room

  const stored = (seq: number, text: string): RoomEvent => ({
    actor_id: 'local',
    actor_kind: 'human',
    created_at: Date.now() / 1000,
    kind: 'message.user',
    payload: { text },
    room_id: 'r1',
    seq
  })

  async function mount(send: (text: string) => Promise<unknown>, history: RoomEvent[] = []) {
    Element.prototype.scrollIntoView = vi.fn()
    useMe.setState({ me: null })

    useRooms.setState({
      byId: { r1: room },
      eventsByRoom: history.length ? { r1: history } : {},
      liveTurnsByRoom: {},
      order: ['r1']
    })

    const call = vi.fn((method: string, input: Record<string, unknown>) =>
      method === 'hexbot.rooms.send'
        ? send(String(input.text))
        : Promise.resolve(
            method === 'hexbot.rooms.log' ? { events: history } : { room: { ...room } }
          )
    )

    setActiveRpc({ call } as never)
    const view = render(<RoomConversation />)
    const field = await screen.findByRole('textbox', { name: 'Message room' })
    fireEvent.change(field, { target: { value: 'hi' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    return { call, field, view }
  }

  const sends = (call: ReturnType<typeof vi.fn>) =>
    call.mock.calls.filter(([method]) => method === 'hexbot.rooms.send').length

  it('clears the field at once and greys the bubble until the room stores it', async () => {
    let store!: () => void

    const { field } = await mount(
      text => new Promise(resolve => (store = () => resolve({ event: stored(1, text) })))
    )

    expect(field).toHaveValue('')
    expect(screen.getByRole('status', { name: 'Sending' })).toBeInTheDocument()
    expect(screen.getByText('hi').closest('.hex-pending')).not.toBeNull()
    await act(async () => store())
    await waitFor(() => expect(screen.queryByTestId('room-unsent')).toBeNull())
    expect(screen.getByText('hi')).toBeVisible()
  })

  it('marks a refused message Not sent, and Retry sends it once', async () => {
    let tries = 0

    const { call } = await mount(text =>
      ++tries === 1
        ? Promise.reject(new JsonRpcGatewayError('room is busy', { code: 4002 }))
        : Promise.resolve({ event: stored(1, text) })
    )

    expect(await screen.findByText('Not sent')).toHaveAttribute('title', 'room is busy')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByTestId('room-unsent')).toBeNull())
    expect(sends(call)).toBe(2)
  })

  it('does not post twice when the first try landed after all', async () => {
    const { call } = await mount(() =>
      Promise.reject(new JsonRpcGatewayError('connection closed', { code: 5200 }))
    )

    expect(await screen.findByText('Not sent')).toBeVisible()
    // The broadcast shows the first try did reach the room.
    act(() => useRooms.getState().handleEvent('r1', stored(7, 'hi')))
    expect(screen.queryByTestId('room-unsent')).toBeNull()
    expect(screen.getAllByText('hi')).toHaveLength(1)
    expect(sends(call)).toBe(1)
  })

  it('keeps a second identical message that failed, and Retry sends it', async () => {
    let tries = 0

    const { call, field } = await mount(text =>
      ++tries === 2
        ? Promise.reject(new JsonRpcGatewayError('room is busy', { code: 4002 }))
        : Promise.resolve({ event: stored(tries, text) })
    )

    await waitFor(() => expect(screen.queryByTestId('room-unsent')).toBeNull())
    fireEvent.change(field, { target: { value: 'hi' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(await screen.findByText('Not sent')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByTestId('room-unsent')).toBeNull())
    expect(sends(call)).toBe(3)
    expect(screen.getAllByText('hi')).toHaveLength(2)
  })

  it('matches a sent message only to events of its own room', async () => {
    let tries = 0
    let lose!: () => void

    const { view } = await mount(text =>
      ++tries === 1
        ? Promise.resolve({ event: stored(1, text) })
        : new Promise((_, reject) => (lose = () => reject(new Error('connection closed'))))
    )

    await waitFor(() => expect(screen.queryByTestId('room-unsent')).toBeNull())
    // Another room numbers its events from 1 too.
    roomId = 'r2'
    act(() =>
      useRooms.setState(state => ({
        byId: { ...state.byId, r2: { ...room, id: 'r2' } },
        order: ['r1', 'r2']
      }))
    )
    view.rerender(<RoomConversation />)
    const field = await screen.findByRole('textbox', { name: 'Message room' })
    fireEvent.change(field, { target: { value: 'hi' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    act(() => useRooms.getState().handleEvent('r2', { ...stored(1, 'hi'), room_id: 'r2' }))
    await act(async () => lose())
    expect(screen.queryByText('Not sent')).toBeNull()
    expect(screen.queryByTestId('room-unsent')).toBeNull()
  })

  it('waits for a late first try before Retry posts again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let answer!: (ok: boolean) => void
    let tries = 0

    try {
      const { call } = await mount(text =>
        ++tries === 1
          ? new Promise((resolve, reject) => {
              answer = ok =>
                ok ? resolve({ event: stored(1, text) }) : reject(new Error('timed out'))
            })
          : Promise.resolve({ event: stored(2, text) })
      )

      act(() => vi.advanceTimersByTime(SEND_TIMEOUT_MS))
      fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
      // The first try is still out: Retry waits for it instead of posting again.
      expect(screen.getByRole('status', { name: 'Sending' })).toBeInTheDocument()
      expect(sends(call)).toBe(1)
      await act(async () => answer(true))
      await waitFor(() => expect(screen.queryByTestId('room-unsent')).toBeNull())
      expect(sends(call)).toBe(1)
      expect(screen.getAllByText('hi')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends again once a late first try fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let answer!: (ok: boolean) => void
    let tries = 0

    try {
      const { call } = await mount(text =>
        ++tries === 1
          ? new Promise((resolve, reject) => {
              answer = ok =>
                ok ? resolve({ event: stored(1, text) }) : reject(new Error('timed out'))
            })
          : Promise.resolve({ event: stored(2, text) })
      )

      act(() => vi.advanceTimersByTime(SEND_TIMEOUT_MS))
      fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
      await act(async () => answer(false))
      await waitFor(() => expect(screen.queryByTestId('room-unsent')).toBeNull())
      expect(sends(call)).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never takes the same words already in the room for this send', async () => {
    // Sent from another app a moment ago.
    await mount(
      () => Promise.reject(new JsonRpcGatewayError('room is busy', { code: 4002 })),
      [stored(5, 'hi')]
    )

    expect(await screen.findByText('Not sent')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible()
  })

  it('shows one bubble when the room broadcasts it before the send answers', async () => {
    let store!: () => void

    await mount(text => new Promise(resolve => (store = () => resolve({ event: stored(1, text) }))))
    act(() => useRooms.getState().handleEvent('r1', stored(1, 'hi')))
    expect(screen.queryByTestId('room-unsent')).toBeNull()
    expect(screen.getAllByText('hi')).toHaveLength(1)
    await act(async () => store())
    expect(screen.getAllByText('hi')).toHaveLength(1)
  })
})
