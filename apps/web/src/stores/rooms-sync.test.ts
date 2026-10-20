import type * as api from '../lib/api'
import { roomsGet, roomsList, roomsLog, roomsMarkRead } from '../lib/api'
import type { Room, RoomEvent } from '../lib/types'

import { applyLog, syncedSeq, useRooms } from './rooms'

vi.mock('../lib/api', async importOriginal => ({
  ...(await importOriginal<typeof api>()),
  roomsGet: vi.fn(),
  roomsList: vi.fn(),
  roomsLog: vi.fn(),
  roomsMarkRead: vi.fn()
}))

const event = (seq: number): RoomEvent => ({
  actor_id: null,
  actor_kind: 'system',
  created_at: 1_700_000_000 + seq,
  kind: 'turn.started',
  payload: {},
  room_id: 'room-1',
  seq
})

const events = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => event(from + index))

const room = { id: 'room-1', members: [], name: 'Plans' } as unknown as Room
const seqs = () => useRooms.getState().eventsByRoom['room-1']?.map(item => item.seq)

beforeEach(() => {
  useRooms.setState({ byId: {}, eventsByRoom: {}, liveTurnsByRoom: {}, order: [] })
  vi.mocked(roomsList).mockResolvedValue({ rooms: [room] })
  vi.mocked(roomsGet).mockResolvedValue({ room })
  vi.mocked(roomsMarkRead).mockResolvedValue({ room })
  vi.mocked(roomsLog).mockReset()
})

describe('room logs', () => {
  it('counts the synced part up to the first gap', () => {
    expect(syncedSeq([])).toBe(0)
    expect(syncedSeq(events(4, 7))).toBe(7)
    // A live event past ones missed while away.
    expect(syncedSeq([...events(1, 3), event(9)])).toBe(3)
  })

  it('keeps live events that arrived while a page loaded', () => {
    expect(
      applyLog([...events(1, 2), event(5)], { events: events(3, 4), latest: false }).map(
        item => item.seq
      )
    ).toEqual([1, 2, 3, 4, 5])
    // The latest page replaces what came before it.
    expect(
      applyLog([...events(1, 2), event(9)], { events: events(5, 8), latest: true }).map(
        item => item.seq
      )
    ).toEqual([5, 6, 7, 8, 9])
  })

  it('loads the latest page first, then only what came after', async () => {
    vi.mocked(roomsLog).mockResolvedValueOnce({ events: events(1, 3) })
    await useRooms.getState().refresh()
    expect(vi.mocked(roomsLog)).toHaveBeenLastCalledWith('room-1', {
      before_seq: Number.MAX_SAFE_INTEGER,
      limit: 1000
    })

    // Missed 4 and 5 while away; 6 came in live after reconnecting.
    useRooms.getState().handleEvent('room-1', event(6))
    vi.mocked(roomsLog).mockResolvedValueOnce({ events: events(4, 6) })
    await useRooms.getState().refresh()
    expect(vi.mocked(roomsLog)).toHaveBeenLastCalledWith('room-1', { after_seq: 3, limit: 1000 })
    expect(seqs()).toEqual([1, 2, 3, 4, 5, 6])

    vi.mocked(roomsLog).mockResolvedValueOnce({ events: [] })
    await useRooms.getState().open('room-1')
    expect(vi.mocked(roomsLog)).toHaveBeenLastCalledWith('room-1', { after_seq: 6, limit: 1000 })
    expect(vi.mocked(roomsMarkRead)).toHaveBeenLastCalledWith('room-1', 6)
  })

  it('starts again from the latest page when too much is missing', async () => {
    useRooms.getState().restore([room], { 'room-1': events(1, 3) })
    vi.mocked(roomsLog)
      .mockResolvedValueOnce({ events: events(4, 1003) })
      .mockResolvedValueOnce({ events: events(2001, 3000) })
    await useRooms.getState().refresh()
    expect(seqs()?.[0]).toBe(2001)
    expect(seqs()).toHaveLength(1000)
  })
})
