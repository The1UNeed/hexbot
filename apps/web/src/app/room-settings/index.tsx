import { useNavigate } from '@tanstack/react-router'
import { Crown, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Avatar } from '../../components/ui/avatar'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Menu } from '../../components/ui/menu'
import { activeBots, RoomCluster } from '../../components/ui/room-cluster'
import { Select } from '../../components/ui/select'
import { roomsPeople } from '../../lib/api'
import { avatarSrc } from '../../lib/avatar-builder'
import { cn } from '../../lib/cn'
import type { ApprovalMode, Bot, Room, User } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useRooms } from '../../stores/rooms'
import { useUsers } from '../../stores/users'
import { cardClass, errorText, Group, Heading, Row } from '../bot-settings/shared'

const errorOf = (cause: unknown) => errorText(cause)

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** "2 bots and you." alone, "2 bots and 3 people." with others in the room. */
export function roomSummary(bots: number, people: number): string {
  return people > 1
    ? `${plural(bots, 'bot')} and ${people} people.`
    : `${plural(bots, 'bot')} and you.`
}

/**
 * One member row, a bot or a person. Removing takes a second click; the last
 * bot warns that the room goes too. People have no main role.
 */
function MemberRow({
  bot,
  isMain = false,
  kind,
  last = false,
  name,
  onMakeMain,
  onRemove,
  readOnly,
  subtitle
}: {
  bot?: Bot
  isMain?: boolean
  kind: 'bot' | 'person'
  last?: boolean
  name: string
  onMakeMain?: () => Promise<void>
  onRemove: () => Promise<void>
  readOnly: boolean
  subtitle?: string
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const label = bot?.display_name ?? name
  const detail = subtitle ?? bot?.title

  const run = async (action: () => Promise<void>) => {
    setBusy(true)

    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-3 py-2.5" data-testid="room-member">
      <div className="flex items-center gap-3">
        <Avatar image={avatarSrc(bot?.avatar)} name={label} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate font-medium">{label}</span>
            {isMain ? (
              <Crown aria-label="Main bot" className="fill-warning text-warning" size={12} />
            ) : null}
          </span>
          {detail ? (
            <span className="block truncate text-[length:var(--text-secondary)] text-muted">
              {detail}
            </span>
          ) : null}
        </span>
        {confirming || readOnly ? null : (
          <>
            {isMain || !onMakeMain ? null : (
              <Button
                disabled={busy}
                onClick={() => void run(onMakeMain)}
                size="sm"
                variant="ghost"
              >
                Make main
              </Button>
            )}
            <Button disabled={busy} onClick={() => setConfirming(true)} size="sm">
              Remove
            </Button>
          </>
        )}
      </div>
      {confirming ? (
        <div className="mt-2 rounded-control bg-background/60 p-3" role="alertdialog">
          <p className="text-[length:var(--text-secondary)]">
            {kind === 'person'
              ? `Remove ${label} from this room? They can no longer read or post in it.`
              : last
                ? `${label} is the last bot here. Removing it deletes this room, its transcript and the memory made from it. The bot itself stays.`
                : `Remove ${label} from this room? Its memory of the room stays with the bot.`}
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              busy={busy}
              onClick={() => void run(onRemove)}
              size="sm"
              variant="danger"
            >
              {last ? 'Remove and delete room' : 'Remove'}
            </Button>
            <Button disabled={busy} onClick={() => setConfirming(false)} size="sm" variant="ghost">
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function LeaveRoom({ onLeave }: { onLeave: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const leave = async () => {
    setBusy(true)
    setError(null)

    try {
      await onLeave()
    } catch (cause) {
      setError(errorOf(cause))
      setBusy(false)
    }
  }

  return (
    <div className={cn(cardClass, 'space-y-3 px-3 py-2.5')}>
      <div className="flex items-center justify-between gap-3">
        <span>
          <span className="block font-medium">Leave room</span>
          <span className="block text-[length:var(--text-secondary)] text-muted">
            {confirming
              ? 'Leave this room? You can no longer read or post in it.'
              : 'Takes the room off your list. Its bots and the other people stay.'}
          </span>
        </span>
        {confirming ? (
          <span className="flex shrink-0 gap-2">
            <Button busy={busy} onClick={() => void leave()} size="sm" variant="danger">
              Leave room
            </Button>
            <Button disabled={busy} onClick={() => setConfirming(false)} size="sm" variant="ghost">
              Cancel
            </Button>
          </span>
        ) : (
          <Button onClick={() => setConfirming(true)} size="sm" variant="danger">
            Leave
          </Button>
        )}
      </div>
      {error ? (
        <p className="text-[length:var(--text-secondary)] text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function DeleteRoom({ onDelete, room }: { onDelete: () => Promise<void>; room: Room }) {
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)

  if (!confirming) {
    return (
      <div className={cn(cardClass, 'flex items-center justify-between gap-3 px-3 py-2.5')}>
        <span>
          <span className="block font-medium">Delete room</span>
          <span className="block text-[length:var(--text-secondary)] text-muted">
            Removes the room, its transcript and the memory made from it. The bots are kept.
          </span>
        </span>
        <Button onClick={() => setConfirming(true)} size="sm" variant="danger">
          Delete
        </Button>
      </div>
    )
  }

  return (
    <div className={cn(cardClass, 'space-y-3 p-3')}>
      <p className="text-[length:var(--text-secondary)]">
        Type <strong>{room.name}</strong> to delete this room.
      </p>
      <Input aria-label="Confirm room name" onChange={e => setTyped(e.target.value)} value={typed} />
      <div className="flex gap-2">
        <Button
          disabled={typed !== room.name}
          onClick={() => void onDelete().catch(cause => setError(errorOf(cause)))}
          variant="danger"
        >
          Delete permanently
        </Button>
        <Button
          onClick={() => {
            setConfirming(false)
            setTyped('')
          }}
          variant="ghost"
        >
          Cancel
        </Button>
      </div>
      {error ? (
        <p className="text-[length:var(--text-secondary)] text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Everything about one room: its name, who is in it and who leads, how tool
 * calls get approved, the per-turn limits, and the door out. The file route
 * owns the dialog; this is the body.
 */
export function RoomSettingsPanel({ room }: { room: Room }): React.JSX.Element {
  const bots = useBots(state => state.byName)
  const current = useUsers(state => state.current)
  const supported = useUsers(state => state.supported)
  const users = useUsers(state => state.users)
  const navigate = useNavigate()
  // Only the person who created the room changes it; the daemon refuses everyone
  // else. Without user accounts there is one person, the owner. Until the
  // current user is known, neither owner controls nor the note show.
  const owner = current ? current.id === room.owner_id : supported === false ? true : null
  const [directory, setDirectory] = useState<Pick<User, 'id' | 'display_name'>[]>([])
  const [name, setName] = useState(room.name)
  const [turns, setTurns] = useState(String(room.limits.bot_turns_per_human_turn ?? ''))
  const [budget, setBudget] = useState(String(room.limits.budget_tokens_per_human_turn ?? ''))
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!owner || current?.role !== 'member') {
      return
    }

    let active = true
    void roomsPeople(room.id)
      .then(result => {
        if (active) {
          setDirectory(result.users)
        }
      })
      .catch(cause => {
        if (active) {
          setError(errorOf(cause))
        }
      })

    return () => {
      active = false
    }
  }, [current?.role, owner, room.id])
  useEffect(() => setName(room.name), [room.name])

  const members = activeBots(room)
  const people = room.members.filter(member => member.member_kind === 'human' && !member.left_at)

  const personName = (id: string) =>
    people.find(person => person.member_id === id)?.display_name ??
    (current?.role === 'member' ? directory : users).find(user => user.id === id)?.display_name ??
    (current?.id === id ? current.display_name : id)

  const addablePeople = (current?.role === 'member' ? directory : users).filter(
    user =>
      !('disabled_at' in user && user.disabled_at) && !people.some(p => p.member_id === user.id)
  )

  const addable = Object.values(bots).filter(bot => !members.some(m => m.member_id === bot.name))
  const rooms = () => useRooms.getState()

  const save = async (patch: Parameters<ReturnType<typeof rooms>['update']>[1]) => {
    try {
      setError(null)
      await rooms().update(room.id, patch)
    } catch (cause) {
      setError(errorOf(cause))
    }
  }

  const remove = async (bot: string) => {
    try {
      setError(null)
      const deleted = await rooms().removeMember(room.id, bot)

      if (deleted) {
        await navigate({ to: '/' })
      }
    } catch (cause) {
      setError(errorOf(cause))
    }
  }

  const removePerson = async (user: string) => {
    try {
      setError(null)
      await rooms().removePerson(room.id, user, false)
    } catch (cause) {
      setError(errorOf(cause))
    }
  }

  const limit = (raw: string) => (raw.trim() === '' ? null : Number(raw))

  const saveLimits = () => {
    const next = [limit(turns), limit(budget)]

    if (next.some(value => value !== null && !Number.isFinite(value))) {
      return
    }

    return save({
      limits: { bot_turns_per_human_turn: next[0], budget_tokens_per_human_turn: next[1] }
    })
  }

  return (
    <section aria-label="Room settings" className="min-w-0 max-w-3xl space-y-6 p-8">
      <div className="flex flex-col items-center gap-2">
        <RoomCluster bots={bots} room={room} size="xl" />
        <Heading description={roomSummary(members.length, people.length)}>
          {room.name}
        </Heading>
      </div>
      {owner !== false ? null : (
        <p className="text-center text-[length:var(--text-secondary)] text-muted" role="note">
          Only the person who created this room can change its name, members and settings.
        </p>
      )}
      {owner ? (
        <Group title="Name">
          <div className="p-3">
            <Input
              aria-label="Room name"
              onBlur={() =>
                name.trim() && name.trim() !== room.name && void save({ name: name.trim() })
              }
              onChange={event => setName(event.target.value)}
              onKeyDown={event => event.key === 'Enter' && event.currentTarget.blur()}
              value={name}
            />
          </div>
        </Group>
      ) : null}
      <Group title="Bots">
        {members.map(member => (
          <MemberRow
            bot={bots[member.member_id]}
            isMain={room.main_bot === member.member_id}
            key={member.member_id}
            kind="bot"
            last={members.length === 1}
            name={member.display_name ?? member.member_id}
            onMakeMain={() => save({ main_bot: member.member_id })}
            onRemove={() => remove(member.member_id)}
            readOnly={!owner}
          />
        ))}
        <div className="flex items-center justify-between gap-3 px-3 py-2">
          <span className="text-[length:var(--text-secondary)] text-muted">
            {room.main_bot
              ? 'The main bot answers when nobody is mentioned.'
              : 'Without a main bot, only mentioned bots answer.'}
          </span>
          {owner ? (
            <Menu
              items={
                addable.length
                  ? addable.map(bot => ({
                      label: bot.display_name,
                      onSelect: () =>
                        void rooms()
                          .addMember(room.id, bot.name)
                          .catch(c => setError(errorOf(c)))
                    }))
                  : [{ disabled: true, label: 'Every bot is already a member' }]
              }
              trigger={
                <Button icon={<Plus size={14} />} size="sm" variant="pill">
                  Add bot
                </Button>
              }
            />
          ) : null}
        </div>
      </Group>
      {people.length > 1 || (owner && addablePeople.length > 0) ? (
        <Group title="People">
          {people.map(person => (
            <MemberRow
              key={person.member_id}
              kind="person"
              name={personName(person.member_id)}
              onRemove={() => removePerson(person.member_id)}
              readOnly={owner !== true || person.member_id === room.owner_id}
              subtitle={
                person.member_id === room.owner_id
                  ? 'Owner'
                  : person.member_id === current?.id
                    ? 'You'
                    : undefined
              }
            />
          ))}
          {owner ? (
            <div className="flex justify-end px-3 py-2">
              <Menu
                items={
                  addablePeople.length
                    ? addablePeople.map(user => ({
                        label: user.display_name,
                        onSelect: () =>
                          void rooms()
                            .addPerson(room.id, user.id)
                            .catch(c => setError(errorOf(c)))
                      }))
                    : [{ disabled: true, label: 'Everyone is already a member' }]
                }
                trigger={
                  <Button icon={<Plus size={14} />} size="sm" variant="pill">
                    Add person
                  </Button>
                }
              />
            </div>
          ) : null}
        </Group>
      ) : null}
      {owner ? (
        <Group title="Turns">
          <Row
            control={
              <div className="w-36 shrink-0">
                <Select
                  label="Room approval mode"
                  onValueChange={value => void save({ approval_mode: value as ApprovalMode })}
                  options={[
                    { label: 'Manual', value: 'manual' },
                    { label: 'Auto', value: 'smart' },
                    { label: 'Off', value: 'off' }
                  ]}
                  value={room.approval_mode ?? 'manual'}
                />
              </div>
            }
            description="How tool actions in this room get approved."
            title="Approval mode"
          />
          <Row
            control={
              <Input
                aria-label="Bot turns per human turn"
                className="w-24 shrink-0"
                min="1"
                onBlur={() => void saveLimits()}
                onChange={event => setTurns(event.target.value)}
                type="number"
                value={turns}
              />
            }
            description="How many bot replies one of your messages can set off."
            title="Bot turns"
          />
          <Row
            control={
              <Input
                aria-label="Token budget per human turn"
                className="w-32 shrink-0"
                min="1"
                onBlur={() => void saveLimits()}
                onChange={event => setBudget(event.target.value)}
                placeholder="No limit"
                type="number"
                value={budget}
              />
            }
            description="Tokens the bots may spend answering one of your messages."
            title="Token budget"
          />
        </Group>
      ) : null}
      {owner === false && current ? (
        <LeaveRoom
          onLeave={async () => {
            await rooms().removePerson(room.id, current.id, true)
            await navigate({ to: '/' })
          }}
        />
      ) : null}
      {owner ? (
        <DeleteRoom
          onDelete={async () => {
            await rooms().remove(room.id)
            await navigate({ to: '/' })
          }}
          room={room}
        />
      ) : null}
      {error ? (
        <p className="text-[length:var(--text-secondary)] text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}
