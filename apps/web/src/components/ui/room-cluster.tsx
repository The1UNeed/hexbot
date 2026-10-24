import { botFace } from '../../lib/avatar-builder'
import { cn } from '../../lib/cn'
import { moodForStatus } from '../../lib/face'
import type { Bot, Room } from '../../lib/types'

import { Avatar } from './avatar'
import { type DotStatus, StatusDot } from './status-dot'

/** A room's active bot members, in the order they joined. */
export const activeBots = (room: Pick<Room, 'members'>) =>
  room.members.filter(member => member.member_kind === 'bot' && !member.left_at)

/**
 * The room's face: one bot's face when it has one bot, otherwise up to four
 * faces in a 2x2 grid. The same cluster sits in the sidebar row, the room
 * header and room settings, so a room looks the same everywhere.
 */
export function RoomCluster({
  bots,
  className,
  room,
  size = 'lg',
  status
}: {
  bots: Record<string, Bot>
  className?: string
  room: Pick<Room, 'members' | 'name'>
  /** `sm` is 24px (headers), `lg` 40px (rows), `xl` 72px (settings). */
  size?: 'lg' | 'sm' | 'xl'
  status?: DotStatus
}) {
  const members = activeBots(room)
  const mood = moodForStatus(status)
  const box = size === 'sm' ? 'size-6' : size === 'xl' ? 'size-[72px]' : 'size-10'
  const cell = size === 'sm' ? 'size-[11px]' : size === 'xl' ? 'size-[34px]' : 'size-[19px]'

  const name = (id: string) =>
    bots[id]?.display_name ?? members.find(member => member.member_id === id)?.display_name ?? id

  return (
    <span
      aria-label={room.name}
      className={cn('relative grid shrink-0 place-items-center', box, className)}
      data-testid="room-cluster"
      role="img"
    >
      {members.length <= 1 ? (
        <Avatar
          {...botFace(bots[members[0]?.member_id ?? ''])}
          mood={mood}
          name={members[0] ? name(members[0].member_id) : room.name}
          size={size}
        />
      ) : (
        <span className={cn('grid grid-cols-2', box, size === 'sm' ? 'gap-px' : 'gap-0.5')}>
          {members.slice(0, 4).map(member => (
            <Avatar
              className={cell}
              {...botFace(bots[member.member_id])}
              key={member.member_id}
              mood={mood}
              name={name(member.member_id)}
              size="xs"
            />
          ))}
        </span>
      )}
      <StatusDot size={size === 'sm' ? 'sm' : 'md'} status={status} />
    </span>
  )
}
