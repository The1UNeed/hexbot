/**
 * One bot's plugins: everything it has, account by account, how it differs
 * from the bots that share its label, and a switch for each plugin. Opened
 * from any bot's name in the table. Its changes join the others that wait
 * for review.
 */

import { Check, TriangleAlert } from 'lucide-react'

import { Avatar } from '../../../components/ui/avatar'
import { Button } from '../../../components/ui/button'
import { Chip } from '../../../components/ui/chip'
import { ConnectorIcon } from '../../../components/ui/connector-icon'
import { Dialog } from '../../../components/ui/dialog'
import { Menu } from '../../../components/ui/menu'
import { Switch } from '../../../components/ui/switch'
import { botFace } from '../../../lib/avatar-builder'
import { cn } from '../../../lib/cn'
import { columnText, count, labelOf, labelsOf, usual } from '../../../lib/plugin-access'
import { ACCOUNT_NAMES } from '../../../lib/plugin-rows'
import { usePluginAccess } from '../../../stores/plugin-access'
import { cardClass } from '../../bot-settings/shared'

import type { AccessData } from './data'

export function BotSheet({ data }: { data: AccessData }) {
  const name = usePluginAccess(state => state.bot)
  const setBot = usePluginAccess(state => state.setBot)
  const setReviewing = usePluginAccess(state => state.setReviewing)
  const { access, bots, colorOf, columns, flips, give, groups } = data
  const bot = bots.find(each => each.name === name)

  if (!bot) {
    return null
  }

  const label = labelOf(bot)
  const keys = columns.map(column => column.key)
  const labels = labelsOf(bots)
  const mates = labels.find(each => each.label.toLowerCase() === label.toLowerCase())?.bots ?? []
  const others = mates.length - 1
  const usually = others > 0 ? usual(label, bots, keys, access.has) : []
  const extra = others > 0 ? columns.filter(column => access.value(bot.name, column.key) && !usually.includes(column.key)) : []
  const missing = columns.filter(column => usually.includes(column.key) && !access.value(bot.name, column.key))
  const mine = flips.filter(flip => flip.bot === bot.name).length
  const held = columns.filter(column => access.value(bot.name, column.key)).length

  return (
    <Dialog
      className="w-[min(560px,94vw)]"
      label={`${bot.display_name}, plugins`}
      onOpenChange={open => !open && setBot(null)}
      open
      scroll={false}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-6 pb-5">
        <div className="flex items-center gap-3.5">
          <Avatar {...botFace(bot)} name={bot.display_name} size="lg" />
          <div className="min-w-0 flex-1">
            <h2 className="text-[length:var(--text-title)] font-semibold tracking-[-0.01em]">
              {bot.display_name}
            </h2>
            <p className="text-[length:var(--text-secondary)] text-muted">
              {bot.primary ? 'Primary bot' : label || 'No label'}, {count(held, 'plugin')}
            </p>
          </div>
          {bot.primary || !labels.length ? null : (
            <Menu
              items={labels.map(each => ({
                label: `What ${each.label} bots usually have`,
                onSelect: () => {
                  const theirs = usual(each.label, bots, keys, access.has)

                  give(
                    [bot.name],
                    keys.filter(key => theirs.includes(key)),
                    true
                  )
                  give(
                    [bot.name],
                    keys.filter(key => !theirs.includes(key)),
                    false
                  )
                }
              }))}
              trigger={<Button size="sm">Match a label</Button>}
            />
          )}
        </div>
        {bot.primary ? (
          <p className="mt-4 rounded-[12px] bg-foreground/[0.04] px-4 py-3 text-[length:var(--text-secondary)] text-muted">
            The primary bot looks after the others, so it usually has every plugin.
          </p>
        ) : others <= 0 ? null : extra.length || missing.length ? (
          <div className="mt-4 rounded-[14px] bg-foreground/[0.04] px-4 py-3">
            <p className="text-[length:var(--text-secondary)] font-medium">
              Differs from the other {count(others, `${label} bot`)}
            </p>
            <ul className="mt-1.5 space-y-1.5">
              {[...extra.map(column => ({ column, on: true })), ...missing.map(column => ({ column, on: false }))].map(
                each => {
                  const staged = access.changed(bot.name, each.column.key)

                  return (
                    <li
                      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--text-secondary)]"
                      key={each.column.key}
                    >
                      <ConnectorIcon
                        className="size-[22px] rounded-[7px] [&_svg]:size-3"
                        icon={each.column.plugin.icon}
                      />
                      <span className="flex-1">
                        {each.on
                          ? staged
                            ? 'Will also have'
                            : 'Also has'
                          : staged
                            ? 'Will no longer have'
                            : 'Has no'}{' '}
                        {columnText(each.column, groups)}
                      </span>
                      <Button onClick={() => give([bot.name], [each.column.key], !each.on)} size="sm">
                        {each.on ? 'Take away' : 'Give'}
                      </Button>
                      {each.on && !each.column.waiting ? (
                        <Button
                          onClick={() =>
                            give(
                              mates.map(mate => mate.name),
                              [each.column.key],
                              true
                            )
                          }
                          size="sm"
                          variant="ghost"
                        >
                          Give to all {label} bots
                        </Button>
                      ) : null}
                    </li>
                  )
                }
              )}
            </ul>
          </div>
        ) : (
          <p className="mt-4 flex items-center gap-2 rounded-[12px] bg-foreground/[0.04] px-4 py-3 text-[length:var(--text-secondary)] text-muted">
            <Check className="shrink-0" size={15} />
            Has the same plugins as the other {count(others, `${label} bot`)}.
          </p>
        )}
        {groups.map(group => (
          <section className="mt-5" key={group.id}>
            <div className="mb-1.5 flex items-center gap-2 px-1 text-[length:var(--text-secondary)]">
              {group.account ? (
                <>
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: colorOf(group.id) }}
                  />
                  <span className="truncate font-medium">{group.name}</span>
                  <span className="text-muted">{ACCOUNT_NAMES[group.account.provider]}</span>
                  {group.waiting ? (
                    <Chip className="ml-auto" tone="warning">
                      <TriangleAlert size={11} />
                      Sign in again
                    </Chip>
                  ) : null}
                </>
              ) : (
                <span className="font-medium">{group.name}</span>
              )}
            </div>
            <div className={cn(cardClass, 'divide-y divide-foreground/[0.07]')}>
              {group.columns.map(column => {
                const on = access.value(bot.name, column.key)
                const changed = access.changed(bot.name, column.key)
                const stuck = !on && !access.canGive(bot.name, column.key)

                const said = changed
                  ? on
                    ? 'Will be given'
                    : 'Will be taken away'
                  : column.waiting && on
                    ? 'Waiting for a new sign-in'
                    : stuck
                      ? column.waiting
                        ? 'Needs a new sign-in first'
                        : 'Not set up for this bot yet'
                      : null

                return (
                  <label className="flex min-h-[46px] items-center gap-3 px-3.5 py-1.5" key={column.key}>
                    <ConnectorIcon icon={column.plugin.icon} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{column.name}</span>
                      {said ? (
                        <span
                          className={cn(
                            'block text-[length:var(--text-meta)]',
                            changed ? 'font-medium' : column.waiting ? 'text-warning' : 'text-muted'
                          )}
                        >
                          {said}
                        </span>
                      ) : null}
                    </span>
                    <Switch
                      aria-label={`${columnText(column, groups)} for ${bot.display_name}`}
                      checked={on}
                      disabled={stuck}
                      onCheckedChange={next => give([bot.name], [column.key], next)}
                    />
                  </label>
                )
              })}
            </div>
          </section>
        ))}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-foreground/[0.08] px-6 py-3">
        <p
          aria-live="polite"
          className="min-w-[10rem] flex-1 text-[length:var(--text-secondary)] text-muted"
          role="status"
        >
          {flips.length ? (
            <>
              <span className="font-medium text-foreground">
                {mine
                  ? `${count(mine, 'change')} for ${bot.display_name}`
                  : `${count(flips.length, 'change')} for other bots`}
              </span>
              {mine && mine < flips.length ? ` and ${flips.length - mine} for other bots` : ''}, not
              applied yet.
            </>
          ) : (
            'Nothing changes until you review.'
          )}
        </p>
        <Button onClick={() => setBot(null)} size="sm" variant={flips.length ? 'ghost' : 'secondary'}>
          {flips.length ? 'Back to the table' : 'Done'}
        </Button>
        {flips.length ? (
          <Button
            onClick={() => {
              setBot(null)
              setReviewing(true)
            }}
            size="sm"
            variant="primary"
          >
            Review
          </Button>
        ) : null}
      </div>
    </Dialog>
  )
}
