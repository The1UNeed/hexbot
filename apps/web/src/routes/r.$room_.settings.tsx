import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { X } from 'lucide-react'

import { AppShell } from '../app/app-shell'
import { RoomSettingsPanel } from '../app/room-settings'
import { Button } from '../components/ui/button'
import { Dialog } from '../components/ui/dialog'
import { RoomCluster } from '../components/ui/room-cluster'
import { useRoomOrLeave } from '../lib/room-or-leave'
import { useBots } from '../stores/bots'

export const Route = createFileRoute('/r/$room_/settings')({ component: RoomSettingsDialog })

function RoomSettingsDialog() {
  const { room: roomId } = Route.useParams()
  const navigate = useNavigate()
  const room = useRoomOrLeave(roomId, 'refresh')
  const bots = useBots(state => state.byName)

  const close = () => void navigate({ params: { room: roomId }, to: '/r/$room' })

  return (
    <>
      <AppShell />
      <Dialog
        className="h-[min(44rem,92vh)] max-h-[92vh] w-[min(44rem,94vw)]"
        onOpenChange={open => !open && close()}
        open
        title={
          <span className="flex items-center gap-2.5">
            {room ? <RoomCluster bots={bots} room={room} size="sm" /> : null}
            <span>{room?.name ?? 'Room'}</span>
            <span className="font-normal text-muted">Room settings</span>
          </span>
        }
        toolbar={
          <Button
            aria-label="Close room settings"
            icon={<X size={16} />}
            onClick={close}
            size="sm"
            variant="ghost"
          />
        }
      >
        {room ? (
          <RoomSettingsPanel room={room} />
        ) : (
          <p className="p-8 text-muted">Loading…</p>
        )}
      </Dialog>
    </>
  )
}
