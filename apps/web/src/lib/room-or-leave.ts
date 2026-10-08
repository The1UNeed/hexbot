import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { useConnection } from '../stores/connection'
import { useRooms } from '../stores/rooms'

import type { Room } from './types'

/**
 * A room, loaded on mount, and a trip home once the daemon says it is gone.
 * `open` loads the room with its log
 * for the conversation. `refresh` fetches only a room the list does not have,
 * and again on reconnect. While the daemon cannot be reached nothing leaves.
 */
export function useRoomOrLeave(roomId: string, load: 'open' | 'refresh'): Room | undefined {
  const navigate = useNavigate()
  const room = useRooms(state => state.byId[roomId])
  const retry = useConnection(state => (load === 'refresh' ? state.status : null))
  const [loadedId, setLoadedId] = useState<null | string>(null)
  useEffect(() => {
    const rooms = useRooms.getState()

    const answered =
      load === 'open'
        ? rooms.open(roomId).then(
            () => true,
            () => false
          )
        : rooms.byId[roomId]
          ? Promise.resolve(true)
          : rooms.refreshOne(roomId)

    let current = true
    setLoadedId(null)
    void answered.then(done => current && done && setLoadedId(roomId))

    return () => {
      current = false
    }
  }, [load, retry, roomId])
  const gone = loadedId === roomId && !room
  useEffect(() => {
    if (gone) {
      void navigate({ to: '/' })
    }
  }, [gone, navigate])

  return room
}
