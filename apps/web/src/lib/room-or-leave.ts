import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { connectionRead, useConnection } from '../stores/connection'
import { useRooms } from '../stores/rooms'

import type { Room } from './types'

/**
 * A room, loaded on mount, and a trip home once the daemon says it is gone.
 * `open` loads the room and log; `refresh` reads membership. Both retry on reconnect.
 * While the daemon cannot be reached nothing leaves.
 */
export function useRoomOrLeave(roomId: string, load: 'open' | 'refresh'): Room | undefined {
  const navigate = useNavigate()
  const room = useRooms(state => state.byId[roomId])
  const retry = useConnection(state => state.status)
  const epoch = useConnection(state => state.epoch)
  const target = useConnection(state => state.target)
  const answer = useRooms(state => state.answers[roomId])
  const [read, setRead] = useState<null | { id: string; current: () => boolean }>(null)
  useEffect(() => {
    const rooms = useRooms.getState()
    const currentRead = connectionRead()

    setRead({ id: roomId, current: currentRead })
    // Cache and discarded reads never answer membership. Observe the current
    // network outcome, including a newer lookup or list that supersedes ours.
    void (load === 'open' ? rooms.open(roomId) : rooms.refreshOne(roomId)).catch(() => undefined)
  }, [epoch, load, retry, roomId, target])
  const gone = read?.id === roomId && read.current() && answer === 'gone'
  useEffect(() => {
    if (gone) {
      void navigate({ to: '/' })
    }
  }, [gone, navigate])

  return room
}
