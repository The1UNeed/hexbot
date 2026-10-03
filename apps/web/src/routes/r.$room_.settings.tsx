import { createFileRoute, useNavigate } from '@tanstack/react-router'

import { AppShell } from '../app/app-shell'
import { RoomSettingsPanel } from '../app/room-settings'
import { SettingsShell } from '../components/ui/settings-shell'
import { useRoomOrLeave } from '../lib/room-or-leave'

export const Route = createFileRoute('/r/$room_/settings')({ component: RoomSettingsDialog })

function RoomSettingsDialog() {
  const { room: roomId } = Route.useParams()
  const navigate = useNavigate()
  const room = useRoomOrLeave(roomId, 'refresh')

  const close = () => void navigate({ params: { room: roomId }, to: '/r/$room' })

  return (
    <>
      <AppShell />
      <SettingsShell
        closeLabel="Close room settings"
        label={`${room?.name ?? 'Room'} settings`}
        onClose={close}
        width="narrow"
      >
        {room ? <RoomSettingsPanel room={room} /> : <p className="p-10 text-muted">Loading…</p>}
      </SettingsShell>
    </>
  )
}
