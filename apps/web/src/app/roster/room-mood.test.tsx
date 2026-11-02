import { act, render, screen, waitFor } from '@testing-library/react'

import { setActiveRpc } from '../../lib/rpc'
import type { Bot, Room, RoomEvent } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useMe } from '../../stores/me'
import { useRooms } from '../../stores/rooms'
import { useTranscripts } from '../../stores/transcripts'
import { RoomConversation } from '../conversation/room'

import { RosterColumn } from './index'

const navigate = vi.hoisted(() => vi.fn())

const router = vi.hoisted(() => ({
  history: { location: {}, subscribe: () => () => undefined },
  subscribe: () => () => undefined
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useParams: () => ({ room: 'lab' }),
  useRouter: () => router
}))

describe.each(['roster', 'header'] as const)('room faces in the %s', surface => {
  it.each([1, 4])('follows room activity with %i bots', async count => {
    Element.prototype.scrollIntoView = vi.fn()
    const names = ['scout', 'writer', 'owl', 'fox'].slice(0, count)

    const room = {
      id: 'lab',
      members: [
        { last_read_seq: 0, member_id: 'local', member_kind: 'human' },
        ...names.map(name => ({ member_id: name, member_kind: 'bot' }))
      ],
      name: 'Lab',
      owner_id: 'local'
    } as Room

    useMe.setState({ me: { display_name: 'Alex', id: 'local' } })
    useBots.setState({
      byName: Object.fromEntries(
        names.map(name => [
          name,
          { avatar: null, display_name: name, name, sections_recent: [] } as unknown as Bot
        ])
      ),
      loaded: true,
      order: names
    })
    useTranscripts.setState({ bySession: {} })
    useRooms.setState({
      byId: { lab: room },
      eventsByRoom: {},
      liveTurnsByRoom: {},
      order: ['lab']
    })

    const call = vi.fn((method: string) =>
      Promise.resolve(
        method === 'hexbot.rooms.log'
          ? { events: [] }
          : method === 'hexbot.rooms.get' || method === 'hexbot.rooms.mark_read'
            ? { room }
            : { connectors: [] }
      )
    )

    setActiveRpc({ call } as never)

    render(surface === 'roster' ? <RosterColumn /> : <RoomConversation />)

    if (surface === 'header') {
      await waitFor(() => expect(call).toHaveBeenCalledWith('hexbot.rooms.log', expect.anything()))
      await act(async () => {})
    }

    const cluster = screen.getByTestId('room-cluster')

    const expectMood = (mood: string) => {
      const faces = cluster.querySelectorAll('.hex-face')
      expect(faces).toHaveLength(count)
      faces.forEach(face => expect(face).toHaveAttribute('data-mood', mood))
    }

    const event = (kind: RoomEvent['kind'], seq: number): RoomEvent => ({
      actor_id: 'scout',
      actor_kind: 'bot',
      created_at: seq,
      kind,
      payload: {},
      room_id: 'lab',
      seq
    })

    const turn = { bot: 'scout', live_session_id: 'live', room_id: 'lab', status: 'running' }

    expectMood('idle')
    act(() => useRooms.getState().handleTurn(turn))
    expect(cluster.querySelector('[data-status]')).toHaveAttribute('data-status', 'working')
    expectMood('working')

    await act(async () => {
      useRooms.getState().handleTurn({ ...turn, status: 'complete' })
      useRooms.getState().handleEvent('lab', event('waiting.human', 1))
    })
    expect(cluster.querySelector('[data-status]')).toHaveAttribute('data-status', 'needs_you')
    expectMood('listening')

    await act(async () => useRooms.getState().handleEvent('lab', event('message.bot', 2)))

    if (surface === 'roster') {
      expect(cluster.querySelector('[data-status]')).toHaveAttribute('data-status', 'done')
      expectMood('happy')
    } else {
      expectMood('idle')
    }

    act(() => useRooms.setState({ eventsByRoom: { lab: [] } }))
    expect(cluster.querySelector('[data-status]')).toBeNull()
    expectMood('idle')
  })
})
