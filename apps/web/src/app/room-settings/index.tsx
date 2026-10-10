import { useNavigate } from '@tanstack/react-router'
import { Crown, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Avatar } from '../../components/ui/avatar'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Menu } from '../../components/ui/menu'
import { activeBots, RoomCluster } from '../../components/ui/room-cluster'
import { Select } from '../../components/ui/select'
import { settingsPageClass } from '../../components/ui/settings-shell'
import { roomsLeave } from '../../lib/api'
import { approvalModes } from '../../lib/approval-modes'
import { avatarSrc } from '../../lib/avatar-builder'
import { cn } from '../../lib/cn'
import type { Bot, BotApprovalMode, Room } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useMe } from '../../stores/me'
import { useRooms } from '../../stores/rooms'
import { errorText, Group, Heading, Row, rowFieldClass } from '../bot-settings/shared'

const errorOf = (cause: unknown) => errorText(cause)

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** "2 bots and you." */
export function roomSummary(bots: number): string {
  return `${plural(bots, 'bot')} and you.`
}

/**
 * One bot in the room. Removing takes a second click; the last bot warns that
 * the room goes too.
 */
function MemberRow({
  bot,
  isMain = false,
  last = false,
  name,
  onMakeMain,
  onRemove
}: {
  bot?: Bot
  isMain?: boolean
  last?: boolean
  name: string
  onMakeMain: () => Promise<void>
  onRemove: () => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const label = bot?.display_name ?? name
  const detail = bot?.title

  const run = async (action: () => Promise<void>) => {
    setBusy(true)

    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-4 py-2.5" data-testid="room-member">
      <div className="flex min-h-[32px] items-center gap-3">
        <Avatar image={avatarSrc(bot?.avatar)} name={label} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate">{label}</span>
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
        {confirming ? null : (
          <>
            {isMain ? null : (
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
        <div className="hex-fade mt-2 rounded-[12px] bg-foreground/[0.04] p-3" role="alertdialog">
          <p className="text-[length:var(--text-secondary)]">
            {last
              ? `${label} is the last bot here. Removing it deletes this room, its transcript and the memory made from it. The bot itself stays.`
              : `Remove ${label} from this room? Its memory of the room stays with the bot.`}
          </p>
          <div className="mt-2 flex gap-2">
            <Button busy={busy} onClick={() => void run(onRemove)} size="sm" variant="danger">
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

function DeleteRoom({ onDelete, room }: { onDelete: () => Promise<void>; room: Room }) {
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)

  return (
    <Group title="Danger zone">
      <Row
        control={
          confirming ? undefined : (
            <Button onClick={() => setConfirming(true)} size="sm" variant="danger">
              Delete
            </Button>
          )
        }
        description="Removes the room, its transcript and the memory made from it. The bots are kept."
        title="Delete room"
      />
      {confirming ? (
        <div className="hex-fade space-y-3 px-4 py-4">
          <p className="text-[length:var(--text-secondary)]">
            Type <strong className="font-semibold">{room.name}</strong> to delete this room.
          </p>
          <Input
            aria-label="Confirm room name"
            autoFocus
            onChange={e => setTyped(e.target.value)}
            value={typed}
          />
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
      ) : null}
    </Group>
  )
}

/**
 * Everything about one room: its name, who is in it and who leads, how tool
 * calls get approved, the per-turn limits, and the door out. The file route
 * owns the dialog; this is the body.
 */
export function RoomSettingsPanel({ room }: { room: Room }): React.JSX.Element {
  const bots = useBots(state => state.byName)
  const navigate = useNavigate()
  const me = useMe(state => state.me)
  const owned = room.owner_id === me?.id
  const [leaving, setLeaving] = useState(false)
  const [name, setName] = useState(room.name)
  const [turns, setTurns] = useState(String(room.limits.bot_turns_per_human_turn ?? ''))
  const [budget, setBudget] = useState(String(room.limits.budget_tokens_per_human_turn ?? ''))
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setName(room.name), [room.name])

  const members = activeBots(room)
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
    <section aria-label="Room settings" className={cn(settingsPageClass, 'space-y-8')}>
      <div className="flex flex-col items-center text-center [&_header]:mb-0">
        <RoomCluster bots={bots} room={room} size="xl" />
        <div className="mt-3">
          <Heading description={roomSummary(members.length)}>{room.name}</Heading>
        </div>
      </div>
      {owned ? (
        <>
          <Group title="Room">
            <label className="grid min-h-[52px] grid-cols-[112px_1fr] items-center gap-4 px-4 py-2">
              <span className="text-muted">Name</span>
              <Input
                aria-label="Room name"
                className={rowFieldClass}
                onBlur={() =>
                  name.trim() && name.trim() !== room.name && void save({ name: name.trim() })
                }
                onChange={event => setName(event.target.value)}
                onKeyDown={event => event.key === 'Enter' && event.currentTarget.blur()}
                value={name}
              />
            </label>
          </Group>
          <Group title="Bots">
            {members.map(member => (
              <MemberRow
                bot={bots[member.member_id]}
                isMain={room.main_bot === member.member_id}
                key={member.member_id}
                last={members.length === 1}
                name={member.display_name ?? member.member_id}
                onMakeMain={() => save({ main_bot: member.member_id })}
                onRemove={() => remove(member.member_id)}
              />
            ))}
            <div className="flex min-h-[48px] items-center justify-between gap-3 px-4 py-2">
              <span className="text-[length:var(--text-secondary)] text-muted">
                {room.main_bot
                  ? 'The main bot answers when nobody is mentioned.'
                  : 'Without a main bot, only mentioned bots answer.'}
              </span>
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
            </div>
          </Group>
          <Group title="Turns">
            <Row
              control={
                <div className="w-40">
                  <Select
                    label="Room approval mode"
                    onValueChange={value => void save({ approval_mode: value as BotApprovalMode })}
                    options={[
                      { label: 'Inherit', value: 'inherit' },
                      ...approvalModes(me?.role, room.approval_mode ?? undefined).map(
                        ({ label, value }) => ({
                          label,
                          value
                        })
                      )
                    ]}
                    value={room.approval_mode ?? 'inherit'}
                  />
                </div>
              }
              description="How tool actions in this room get approved. Inherit uses each bot's own mode."
              title="Approval mode"
            />
            <Row
              control={
                <Input
                  aria-label="Bot turns per human turn"
                  className="w-24 text-right"
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
                  className="w-32 text-right"
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
          <DeleteRoom
            onDelete={async () => {
              await rooms().remove(room.id)
              await navigate({ to: '/' })
            }}
            room={room}
          />
        </>
      ) : me ? (
        <Group title="Membership">
          <Row
            control={
              leaving ? undefined : (
                <Button onClick={() => setLeaving(true)} size="sm" variant="danger">
                  Leave
                </Button>
              )
            }
            description="The room and its transcript stay with its owner."
            title="Leave room"
          />
          {leaving ? (
            <div className="hex-fade space-y-3 px-4 py-4" role="alertdialog">
              <p className="text-[length:var(--text-secondary)]">
                Leave this room? You can no longer read or post in it.
              </p>
              <div className="flex gap-2">
                <Button
                  onClick={() =>
                    void roomsLeave(room.id, me.id)
                      .then(async () => {
                        rooms().drop(room.id)
                        await navigate({ to: '/' })
                      })
                      .catch(cause => setError(errorOf(cause)))
                  }
                  size="sm"
                  variant="danger"
                >
                  Leave
                </Button>
                <Button onClick={() => setLeaving(false)} size="sm" variant="ghost">
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
        </Group>
      ) : null}
      {error ? (
        <p className="text-[length:var(--text-secondary)] text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}
