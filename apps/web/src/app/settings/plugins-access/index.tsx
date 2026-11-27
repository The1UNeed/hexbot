/**
 * Settings, Plugins as a table (Experimental). Every bot against every
 * plugin, under the account it comes from. Bots that share a label and hold
 * the same plugins fold into one row; changes wait until they are reviewed.
 * Plugins are added and connected here too, from Add plugin.
 */

import { Check, ChevronDown, ChevronRight, CornerDownLeft, Plus, Search, TriangleAlert, X } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'

import { Avatar } from '../../../components/ui/avatar'
import { Button } from '../../../components/ui/button'
import { ConnectorIcon } from '../../../components/ui/connector-icon'
import { Menu, type MenuItem } from '../../../components/ui/menu'
import { SkeletonLines } from '../../../components/ui/skeleton'
import { botFace } from '../../../lib/avatar-builder'
import { cn } from '../../../lib/cn'
import {
  type AccessColumn,
  type AccessGroup,
  accessOf,
  type AccessRow,
  columnText,
  count,
  foldRows,
  groupName,
  labelOf,
  labelsOf,
  listed,
  sharedLabels,
  waitingIds
} from '../../../lib/plugin-access'
import { ACCOUNT_NAMES, isDiscord, namedPlugin } from '../../../lib/plugin-rows'
import { parseSentence } from '../../../lib/plugin-sentence'
import type { Bot } from '../../../lib/types'
import { useConnection } from '../../../stores/connection'
import { usePluginAccess } from '../../../stores/plugin-access'
import { usePlugins } from '../../../stores/plugins'
import { Heading } from '../../bot-settings/shared'
import { PluginSheet } from '../plugin-sheet'

import { AddPlugin } from './add'
import { BotSheet } from './bot-sheet'
import { GrantCell, useGrid } from './cells'
import { ChangeBar } from './changes'
import { useAccessData } from './data'

/** Rows a group opens with, and bots a flat list grows by. */
const STEP = 12
const PAGE = 40

/** Bots with no label, as the label filter names them. */
const NO_LABEL = ''

/** True while the element is narrower than `width`. */
function useNarrow(width: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)

  useEffect(() => {
    const element = ref.current

    if (!element || typeof ResizeObserver !== 'function') {
      return
    }

    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        setNarrow(entry.contentRect.width < width)
      }
    })

    observer.observe(element)

    return () => observer.disconnect()
  }, [width])

  return [ref, narrow] as const
}

function Faces({ bots }: { bots: Bot[] }) {
  return (
    <span aria-hidden className="hidden shrink-0 -space-x-1.5 @min-[600px]:flex">
      {bots.slice(0, 2).map(bot => (
        <Avatar
          {...botFace(bot)}
          className="rounded-full ring-2 ring-background"
          key={bot.name}
          name={bot.display_name}
          size="sm"
        />
      ))}
    </span>
  )
}

const pill = (on: boolean) =>
  cn(
    'hex-focus inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[length:var(--text-secondary)] font-medium whitespace-nowrap transition-colors',
    on ? 'bg-foreground text-background' : 'bg-foreground/[0.07] hover:bg-foreground/[0.11]'
  )

export function PluginsAccess() {
  const data = useAccessData()
  const { access, bots, colorOf, columns, flips, give, groups, plugins, press } = data
  const add = usePluginAccess(state => state.setAdding)
  const arrived = usePluginAccess(state => state.arrived)
  const setArrived = usePluginAccess(state => state.setArrived)
  const sheet = usePluginAccess(state => state.sheet)
  const setSheet = usePluginAccess(state => state.setSheet)
  const setBot = usePluginAccess(state => state.setBot)
  const pinned = usePluginAccess(state => state.pinned)
  const regroup = usePluginAccess(state => state.regroup)
  const busy = usePluginAccess(state => state.busy)
  const loading = usePlugins(state => state.loading)
  const loaded = usePlugins(state => state.loaded)
  const loadError = usePlugins(state => state.error)
  const refresh = usePlugins(state => state.refresh)
  const sought = usePlugins(state => state.sought)
  const [query, setQuery] = useState('')
  const [label, setLabel] = useState<null | string>(null)
  const [only, setOnly] = useState<{ has: boolean; key: string } | null>(null)
  const [folded, setFolded] = useState(true)
  const [limit, setLimit] = useState(PAGE)
  const [open, setOpen] = useState<string[]>([])
  const [full, setFull] = useState<string[]>([])
  const [ticked, setTicked] = useState<string[]>([])
  const [hidden, setHidden] = useState<string[]>([])
  const [solo, setSolo] = useState<null | string>(null)
  const [warned, setWarned] = useState(false)
  const [wrap, narrow] = useNarrow(560)
  const field = useRef<HTMLInputElement>(null)

  // Load again after any reconnect or a switch to another daemon, which has other bots and plugins.
  const target = useConnection(state => state.target)
  const epoch = useConnection(state => state.epoch)
  const connects = useConnection(state => state.connects)
  useEffect(() => {
    void refresh()

    // Events refresh the list only while this page is open.
    return () => usePlugins.setState({ loaded: false })
  }, [connects, epoch, refresh, target])
  // Leaving the page closes what it had open. The changes that wait stay for
  // the next visit; the store forgets them when the daemon is another one.
  useEffect(
    () => () =>
      usePluginAccess.setState({ adding: null, arrived: [], bot: null, reviewing: false, sheet: null }),
    []
  )

  // A tag in a message named a plugin or a skill: its own window opens, or
  // the page that adds one, searched for it.
  useEffect(() => {
    // Not before the list is in: the first visit starts with none.
    if (!sought || loading || !loaded) {
      return
    }

    const found = namedPlugin(plugins, sought.kind, sought.name)

    if (found) {
      setSheet(`${found.kind}:${found.id}`)
    } else {
      add({ at: 'pick', query: sought.name })
    }

    usePlugins.setState({ sought: null })
  }, [add, loaded, loading, plugins, setSheet, sought])

  // Columns that just arrived come into view, lit, then settle.
  useEffect(() => {
    if (!arrived.length) {
      return
    }

    // A group of columns that was hidden shows again for what arrived in it.
    setHidden(hidden =>
      hidden.filter(id => !groups.some(group => group.id === id && group.columns.some(column => arrived.includes(column.key))))
    )

    const arrival = groups.find(group => group.columns.some(column => arrived.includes(column.key)))

    if (arrival) {
      setSolo(arrival.id)
    }

    const frame = requestAnimationFrame(() =>
      document
        .querySelector(`[data-cell="head/${CSS.escape(arrived[arrived.length - 1]!)}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
    )

    const timer = setTimeout(() => setArrived([]), 2600)

    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [arrived, groups, setArrived])

  const labels = useMemo(() => labelsOf(bots), [bots])
  const world = useMemo(() => ({ bots, groups }), [bots, groups])
  // A sentence in the field is a change or a question, not a search.
  const sentence = useMemo(() => parseSentence(query, world), [query, world])
  const needle = sentence ? '' : query.trim().toLowerCase()

  const shown = useMemo(
    () =>
      bots.filter(
        bot =>
          (label === null || labelOf(bot).toLowerCase() === label.toLowerCase()) &&
          (!needle || `${bot.display_name} ${bot.name} ${labelOf(bot)}`.toLowerCase().includes(needle)) &&
          // A box just pressed keeps its row: the change shows where it was made.
          (!only || access.value(bot.name, only.key) === only.has || access.changed(bot.name, only.key))
      ),
    [access, bots, label, needle, only]
  )

  const keys = useMemo(() => columns.map(column => column.key), [columns])
  const shared = useMemo(() => sharedLabels(bots), [bots])

  // Rows fold by the grants as they were before the last apply, so a row keeps its place.
  const basis = useMemo(() => accessOf(pinned ?? plugins, {}), [pinned, plugins])

  const rows: AccessRow[] = useMemo(
    () =>
      folded
        ? foldRows(shown, keys, basis.has, shared)
        : shown.slice(0, limit).map(bot => ({ bots: [bot], id: `bot:${bot.name}`, label: labelOf(bot) })),
    [basis, folded, keys, limit, shared, shown]
  )

  const stale = useMemo(
    () =>
      Boolean(pinned) &&
      folded &&
      foldRows(shown, keys, accessOf(plugins, {}).has, shared)
        .map(row => row.id)
        .join('|') !== rows.map(row => row.id).join('|'),
    [folded, keys, pinned, plugins, rows, shared, shown]
  )

  const visible = narrow
    ? groups.filter(group => group.id === (solo ?? groups[0]?.id))
    : groups.filter(group => !hidden.includes(group.id))

  const shownColumns = visible.flatMap(group => group.columns)
  const starts = new Set(visible.map(group => group.columns[0]!.key))

  const grid = useGrid(
    `${rows.map(row => row.id).join()}:${open.join()}:${full.join()}:${visible.map(group => group.id).join()}`
  )

  // The first read of the plugins, or of the bots, is still on its way.
  const waiting = !bots.length || (!columns.length && (loading || !loaded))
  const first = rows[0] ? `${rows[0].id}/name` : ''
  const tickedBots = bots.filter(bot => ticked.includes(bot.name))
  const opened = plugins.find(plugin => `${plugin.kind}:${plugin.id}` === sheet)
  const textOf = (column: AccessColumn) => columnText(column, groups)

  // The table listens once for every cell; a cell names its row and column.
  const rowBots = new Map<string, string[]>()

  for (const row of rows) {
    rowBots.set(
      row.id,
      row.bots.map(bot => bot.name)
    )

    for (const bot of row.bots) {
      rowBots.set(`bot:${bot.name}`, [bot.name])
    }
  }

  const tick = (names: string[], on: boolean) =>
    setTicked(on ? [...new Set([...ticked, ...names])] : ticked.filter(name => !names.includes(name)))

  /** What the sentence in the field would do, said back before anything is staged. */
  const answer = (() => {
    if (!sentence) {
      return null
    }

    switch (sentence.kind) {
      case 'problem':
        return { problem: sentence.text }

      case 'about':
        return {
          act: () => {
            setBot(sentence.bot.name)
            setQuery('')
          },
          button: `Open ${sentence.bot.display_name}`,
          text: `${sentence.bot.display_name}'s page lists everything it has.`
        }

      case 'label':
        return {
          act: () => {
            setLabel(sentence.label)
            setQuery('')
          },
          button: `Show ${sentence.label} bots`,
          text: `The table can show only the ${sentence.label} bots.`
        }
      case 'who': {
        const holders = bots.filter(bot => access.value(bot.name, sentence.column.key) === sentence.has)

        return {
          act: () => {
            setOnly({ has: sentence.has, key: sentence.column.key })
            setLabel(null)
            setQuery('')
          },
          button: 'Show only them',
          note: flips.length ? 'This counts the changes that are not applied yet.' : undefined,
          text: `${count(holders.length, 'bot')} ${holders.length === 1 ? (sentence.has ? 'has' : 'does not have') : sentence.has ? 'have' : 'do not have'} ${textOf(sentence.column)}.`
        }
      }

      default: {
        const { on } = sentence
        const wanted = sentence.columns.map(column => column.key)

        const changing = sentence.bots.filter(bot =>
          wanted.some(key => access.value(bot.name, key) !== on && (!on || access.canGive(bot.name, key)))
        )

        const stuck = sentence.bots.filter(
          bot => on && wanted.some(key => !access.value(bot.name, key) && !access.canGive(bot.name, key))
        ).length

        const one = sentence.bots.length === 1
        const who = sentence.who[0]!.toUpperCase() + sentence.who.slice(1)

        const text = `${who}${sentence.but ? `, but not ${sentence.but},` : ''} ${on ? (one ? 'gets' : 'get') : one ? 'loses' : 'lose'} ${listed(sentence.columns.map(textOf))}.`

        const same = sentence.bots.length - changing.length - stuck

        const note = [
          changing.length ? `${count(changing.length, 'bot')} ${changing.length === 1 ? 'changes' : 'change'}.` : '',
          same > 0 ? `${same} ${on ? (same === 1 ? 'already has it' : 'already have it') : same === 1 ? 'never had it' : 'never had it'}.` : '',
          stuck ? `${stuck} cannot have it until it is set up for them.` : ''
        ]
          .filter(Boolean)
          .join(' ')

        if (!changing.length) {
          return { problem: `${text} Nothing to change. ${note}`.trim() }
        }

        return {
          act: () => {
            give(
              changing.map(bot => bot.name),
              wanted,
              on
            )
            setQuery('')
          },
          button: 'Add to changes',
          note,
          text
        }
      }
    }
  })()

  /** Give or take away one plugin for many bots, as a menu grouped as the table is. */
  const bulk = (names: string[], on: boolean): MenuItem[] =>
    groups.flatMap((group, index) => [
      ...(index ? [{ label: '', separator: true }] : []),
      ...group.columns
        .filter(column => !on || !column.waiting)
        .map(column => ({
          label: (
            <span className="flex items-center gap-2">
              <ConnectorIcon className="size-[22px] rounded-[7px] [&_svg]:size-3" icon={column.plugin.icon} />
              {textOf(column)}
            </span>
          ),
          onSelect: () => give(names, [column.key], on)
        }))
    ])

  const cells = (rowBotsList: Bot[], id: string, name: string, line = false) =>
    shownColumns.map(column => {
      const names = rowBotsList.map(bot => bot.name)

      return (
        <td
          className={cn(
            'p-0',
            starts.has(column.key) && 'pl-3',
            line && 'border-b border-foreground/[0.07]',
            arrived.includes(column.key) && 'hex-lit'
          )}
          key={column.key}
        >
          <GrantCell
            blocked={names.every(bot => !access.canGive(bot, column.key))}
            changed={names.some(bot => access.changed(bot, column.key))}
            col={column.key}
            color={colorOf(column.group)}
            held={names.filter(bot => access.value(bot, column.key)).length}
            label={`${textOf(column)} for ${name}`}
            row={id}
            size={names.length}
            tab={grid.tab(`${id}/${column.key}`)}
            waiting={column.waiting}
          />
        </td>
      )
    })

  const tickBox = (rowBotsList: Bot[], id: string, name: string) => {
    const names = rowBotsList.map(bot => bot.name)
    const held = names.filter(bot => ticked.includes(bot)).length

    return (
      <input
        aria-label={`Select ${name}`}
        checked={held === names.length}
        className="hex-focus size-4 shrink-0 rounded-[4px] accent-[var(--hex-text)]"
        data-cell={`${id}/tick`}
        data-col="tick"
        onChange={event => tick(names, event.target.checked)}
        ref={element => {
          if (element) {
            element.indeterminate = held > 0 && held < names.length
          }
        }}
        tabIndex={grid.tab(`${id}/tick`) ? 0 : -1}
        type="checkbox"
      />
    )
  }

  const botLink = (bot: Bot, id: string, className?: string) => (
    <button
      aria-label={`${bot.display_name}, open its plugins`}
      className={cn(
        'hex-focus inline-flex min-h-8 min-w-0 items-center gap-2 rounded-[8px] text-left decoration-foreground/25 underline-offset-2 hover:underline focus-visible:outline-foreground!',
        className
      )}
      data-cell={`${id}/name`}
      data-col="name"
      onClick={() => setBot(bot.name)}
      tabIndex={grid.tab(`${id}/name`, first === `${id}/name`) ? 0 : -1}
      type="button"
    >
      <Avatar {...botFace(bot)} name={bot.display_name} size="sm" />
      <span className="truncate">{bot.display_name}</span>
    </button>
  )

  // Names stay in view while the plugins scroll sideways.
  const pinnedCell =
    'sticky left-0 z-10 bg-background shadow-[1px_0_0_color-mix(in_srgb,var(--hex-text)_7%,transparent)]'

  /** On a heading that opens a menu: the arrows move through the grid, and only Enter and Space open it. */
  const arrowsMove = (event: React.KeyboardEvent) => {
    if (event.key.startsWith('Arrow')) {
      ;(event as { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.()
    }
  }

  /** What an account's heading, or a kind's, offers. */
  const groupMenu = (group: AccessGroup): MenuItem[] => {
    const renew = waitingIds(group)

    return [
      ...(group.account && renew.length
        ? [
            {
              label: 'Sign in again',
              onSelect: () =>
                add({ again: true, at: 'sign-in', provider: group.account!.provider, services: renew })
            }
          ]
        : []),
      group.account
        ? {
            label: `Connect more from ${ACCOUNT_NAMES[group.account.provider]}`,
            onSelect: () => add({ at: 'services', provider: group.account!.provider })
          }
        : group.id === 'servers'
          ? { label: 'Add an MCP server', onSelect: () => add({ at: 'server' }) }
          : group.id === 'skills'
            ? { label: 'Add a skill', onSelect: () => add({ at: 'skill' }) }
            : { label: 'Add a connector', onSelect: () => add({ at: 'pick' }) },
      { label: '', separator: true },
      narrow
        ? { disabled: true, label: 'One group of columns shows at this width' }
        : { label: 'Hide these columns', onSelect: () => setHidden([...hidden, group.id]) }
    ]
  }

  const shownGroups = narrow ? 1 : groups.length - hidden.filter(id => groups.some(group => group.id === id)).length

  return (
    <div
      onKeyDown={event => {
        // Escape closes Settings. With changes waiting, the first press says
        // so and stays; the second closes, and the changes are kept.
        if (event.key === 'Escape' && flips.length && !warned && !event.defaultPrevented) {
          event.stopPropagation()
          setWarned(true)
          document.querySelector<HTMLElement>('[data-change-bar]')?.focus()
        }
      }}
      ref={wrap}
    >
      <Heading description="Every bot against every plugin, under the account it comes from. Changes wait until you review them.">
        Plugins
      </Heading>
      {loadError ? (
        <p className="mb-3 rounded-[12px] bg-danger/10 px-4 py-3 text-[length:var(--text-secondary)] text-danger" role="alert">
          {loadError}
        </p>
      ) : null}
      {waiting ? (
        <SkeletonLines className="py-2" label="Loading plugins" lines={6} />
      ) : !columns.length ? (
        <div className="hex-fade rounded-2xl bg-foreground/[0.04] px-6 py-10 text-center">
          <p className="font-medium">No plugin is set up yet</p>
          <p className="mx-auto mt-1 max-w-[26rem] text-[length:var(--text-secondary)] text-muted">
            Sign in to an account, set up a service, or add an MCP server or a skill. Each one becomes a
            column here, and you choose the bots that get it.
          </p>
          <Button
            className="mt-4"
            icon={<Plus size={14} />}
            onClick={() => add({ at: 'pick' })}
            size="sm"
            variant="primary"
          >
            Add plugin
          </Button>
        </div>
      ) : (
        <>
          <form
            className="mb-2"
            onSubmit={event => {
              event.preventDefault()
              answer?.act?.()
            }}
          >
            <label className="relative block">
              <Search
                className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted"
                size={15}
              />
              <input
                aria-describedby="plugins-field-help"
                aria-label="Find a bot, or type a change"
                className="h-10 w-full rounded-full bg-surface-2/60 pr-10 pl-10 text-[length:var(--text-body)] transition-colors outline-none placeholder:text-muted hover:bg-surface-2/80 focus-visible:bg-background focus-visible:outline-2 focus-visible:outline-foreground"
                onChange={event => setQuery(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Escape' && query) {
                    // Escape empties the field before it closes Settings.
                    event.stopPropagation()
                    setQuery('')
                  }
                }}
                placeholder={`Find a bot, or type a change: give ${labels[0] ? `${labels[0].label} bots` : 'every bot'} ${columns[0]!.name}`}
                ref={field}
                value={query}
              />
              {query ? (
                <button
                  aria-label="Clear"
                  className="hex-focus absolute top-1/2 right-2.5 grid size-6 -translate-y-1/2 place-items-center rounded-full text-muted hover:text-foreground"
                  onClick={() => {
                    setQuery('')
                    field.current?.focus()
                  }}
                  type="button"
                >
                  <X size={14} />
                </button>
              ) : null}
            </label>
            <p className="sr-only" id="plugins-field-help">
              Type a name to find a bot. Or type a sentence that starts with give, take, who or what:
              give every bot a plugin, take a plugin from a bot, who has a plugin, or what does a bot
              have. Nothing changes until you review it.
            </p>
            {answer ? (
              <div
                aria-live="polite"
                className="hex-fade mt-2 flex flex-wrap items-center gap-3 rounded-[14px] bg-foreground/[0.04] py-2 pr-2 pl-4"
                role="status"
              >
                <p
                  className={cn(
                    'min-w-[12rem] flex-1 py-1 text-[length:var(--text-secondary)]',
                    answer.problem && 'text-warning'
                  )}
                >
                  {answer.problem ?? (
                    <>
                      <span className="font-medium">{answer.text}</span>
                      {answer.note ? <span className="text-muted"> {answer.note}</span> : null}
                    </>
                  )}
                </p>
                {answer.act ? (
                  <Button icon={<CornerDownLeft size={13} />} size="sm" type="submit" variant="primary">
                    {answer.button}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </form>
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <Menu
              items={[
                { label: 'All labels', onSelect: () => setLabel(null) },
                ...labels.map(each => ({
                  label: `${each.label} (${each.bots.length})`,
                  onSelect: () => setLabel(each.label)
                })),
                { label: 'No label', onSelect: () => setLabel(NO_LABEL) }
              ]}
              trigger={
                <button className={pill(label !== null)} type="button">
                  <span className="font-normal opacity-70">Label</span>
                  {label === null ? 'All' : label || 'None'}
                  <ChevronDown className="opacity-70" size={13} />
                </button>
              }
            />
            <Menu
              items={[
                { label: 'Fold bots with the same plugins', onSelect: () => setFolded(true) },
                {
                  label: 'One row for every bot',
                  onSelect: () => {
                    setFolded(false)
                    setLimit(PAGE)
                  }
                }
              ]}
              trigger={
                <button className={pill(!folded)} type="button">
                  <span className="font-normal opacity-70">Rows</span>
                  {folded ? 'Same plugins' : 'Every bot'}
                  <ChevronDown className="opacity-70" size={13} />
                </button>
              }
            />
            {only ? (
              <button
                aria-label={`Showing only bots ${only.has ? 'with' : 'without'} ${columns.find(column => column.key === only.key)?.name}. Clear`}
                className={pill(true)}
                onClick={() => setOnly(null)}
                type="button"
              >
                {only.has ? 'Has' : 'Has no'} {columns.find(column => column.key === only.key)?.name}
                <X size={13} />
              </button>
            ) : null}
            <Menu
              items={groups.map(group => {
                const on = narrow ? (solo ?? groups[0]?.id) === group.id : !hidden.includes(group.id)

                return {
                  label: (
                    <span className="flex w-full items-center gap-2">
                      <span
                        aria-hidden
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: group.account ? colorOf(group.id) : 'transparent' }}
                      />
                      <span className="min-w-0 flex-1 truncate">{group.name}</span>
                      {group.waiting ? <TriangleAlert className="shrink-0 text-warning" size={12} /> : null}
                      <Check aria-hidden className={cn('ml-3 shrink-0', !on && 'invisible')} size={14} />
                      <span className="sr-only">{on ? ', shown' : ', hidden'}</span>
                    </span>
                  ),
                  onSelect: () =>
                    narrow
                      ? setSolo(group.id)
                      : setHidden(on ? [...hidden, group.id] : hidden.filter(id => id !== group.id))
                }
              })}
              trigger={
                <button className={pill(!narrow && shownGroups < groups.length)} type="button">
                  <span className="font-normal opacity-70">Columns</span>
                  <span className="max-w-[9rem] truncate">
                    {narrow
                      ? (groups.find(group => group.id === (solo ?? groups[0]?.id))?.name ?? '')
                      : shownGroups === groups.length
                        ? 'All'
                        : `${shownGroups} of ${groups.length}`}
                  </span>
                  <ChevronDown className="opacity-70" size={13} />
                </button>
              }
            />
            <Button
              className="ml-auto rounded-full"
              icon={<Plus size={14} />}
              onClick={() => add({ at: 'pick' })}
              size="sm"
              variant="primary"
            >
              Add plugin
            </Button>
          </div>
          {groups
            .filter(group => group.account && group.waiting)
            .map(group => (
              <div
                className="hex-fade mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[14px] bg-warning/[0.1] py-2 pr-2 pl-3.5 text-[length:var(--text-secondary)]"
                key={group.id}
                role="status"
              >
                <TriangleAlert className="shrink-0 text-warning" size={15} />
                <p className="min-w-[12rem] flex-1 py-1">
                  <span className="font-medium">{group.name} needs a new sign-in.</span>{' '}
                  <span className="text-muted">
                    {listed(group.columns.filter(column => column.waiting).map(column => column.name))} stopped
                    working. Bots keep their boxes, and nothing new is given until then.
                  </span>
                </p>
                <Button
                  onClick={() =>
                    add({ again: true, at: 'sign-in', provider: group.account!.provider, services: waitingIds(group) })
                  }
                  size="sm"
                >
                  Sign in again
                </Button>
              </div>
            ))}
          <div className="max-h-[min(60vh,600px)] scroll-pt-[112px] scroll-pl-[216px] overflow-auto rounded-2xl bg-background shadow-[var(--hex-card-shadow)]">
            <table
              aria-busy={busy || undefined}
              aria-label="Bots and their plugins"
              className="w-full border-separate border-spacing-0"
              onClick={event => {
                const cell = (event.target as HTMLElement).closest<HTMLElement>('[data-grant]')
                const names = cell ? rowBots.get(cell.dataset.row!) : undefined

                if (cell && names && !busy) {
                  setWarned(false)
                  press(names, cell.dataset.col!)
                }
              }}
              role="grid"
              {...grid.props}
            >
              <thead className="sticky top-0 z-20 bg-background">
                <tr>
                  <th className={cn(pinnedCell, 'min-w-[150px] @min-[600px]:min-w-[208px]')} />
                  {visible.map(group => (
                    <th
                      className="max-w-0 pt-3 pb-1.5 pl-3 text-[length:var(--text-meta)] font-semibold"
                      colSpan={group.columns.length}
                      key={group.id}
                      scope="colgroup"
                    >
                      <Menu
                        items={groupMenu(group)}
                        trigger={
                          <button
                            aria-label={`${group.name}${group.account ? `, ${ACCOUNT_NAMES[group.account.provider]} account` : ''}${group.waiting ? ', needs a new sign-in' : ''}. Open its menu`}
                            className="hex-focus flex w-full items-center gap-1.5 rounded-t-[8px] border-b-2 px-1.5 pt-1 pb-1 transition-colors duration-[var(--hex-motion-fast)] hover:bg-foreground/[0.05] focus-visible:outline-foreground!"
                            // Part of the grid: up from its first column's heading.
                            data-cell={`group/${group.id}`}
                            data-col={group.columns[0]!.key}
                            onKeyDown={arrowsMove}
                            style={{ borderColor: group.account ? colorOf(group.id) : 'var(--hex-border)' }}
                            tabIndex={grid.tab(`group/${group.id}`) ? 0 : -1}
                            title={group.name}
                            type="button"
                          >
                            {group.account ? (
                              <span
                                aria-hidden
                                className="size-2 shrink-0 rounded-full"
                                style={{ backgroundColor: colorOf(group.id) }}
                              />
                            ) : null}
                            <span className="truncate">{group.name}</span>
                            {group.waiting ? (
                              <TriangleAlert aria-hidden className="shrink-0 text-warning" size={12} />
                            ) : null}
                            {/* A narrow group keeps its room for the address. */}
                            {group.columns.length > 2 ? (
                              <ChevronDown aria-hidden className="shrink-0 text-muted" size={12} />
                            ) : null}
                          </button>
                        }
                      />
                    </th>
                  ))}
                  <th className="w-[52px]" />
                </tr>
                <tr>
                  <th
                    className={cn(
                      pinnedCell,
                      'border-b border-foreground/[0.09] pb-2 pl-4 text-left align-bottom text-[length:var(--text-meta)] font-normal text-muted'
                    )}
                    scope="col"
                  >
                    {count(shown.length, 'bot')}
                    {folded ? ` in ${count(rows.length, 'row')}` : ''}
                  </th>
                  {shownColumns.map(column => {
                    const holders = shown.filter(bot => access.value(bot.name, column.key)).length
                    const names = shown.map(bot => bot.name)

                    return (
                      <th
                        className={cn(
                          'border-b border-foreground/[0.09] p-0 pb-1 font-normal',
                          starts.has(column.key) && 'pl-3',
                          arrived.includes(column.key) && 'hex-lit'
                        )}
                        key={column.key}
                        scope="col"
                      >
                        <Menu
                          items={[
                            { label: `Open ${column.name}`, onSelect: () => setSheet(column.key) },
                            { label: '', separator: true },
                            {
                              label: 'Show only bots with it',
                              onSelect: () => setOnly({ has: true, key: column.key })
                            },
                            {
                              label: 'Show only bots without it',
                              onSelect: () => setOnly({ has: false, key: column.key })
                            },
                            { label: '', separator: true },
                            {
                              disabled: column.waiting,
                              label: `Give to the ${count(shown.length, 'bot')} shown`,
                              onSelect: () => give(names, [column.key], true)
                            },
                            {
                              label: `Take away from the ${count(shown.length, 'bot')} shown`,
                              onSelect: () => give(names, [column.key], false)
                            }
                          ]}
                          trigger={
                            <button
                              aria-label={`${textOf(column)}, ${count(holders, 'bot')} of ${shown.length} shown. Open its menu`}
                              className="hex-focus mx-auto flex w-[58px] flex-col items-center rounded-[8px] py-1 text-[10px] leading-[1.15] text-muted hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-foreground!"
                              data-cell={`head/${column.key}`}
                              data-col={column.key}
                              onKeyDown={arrowsMove}
                              tabIndex={grid.tab(`head/${column.key}`) ? 0 : -1}
                              title={textOf(column)}
                              type="button"
                            >
                              <ConnectorIcon
                                className="size-[22px] rounded-[7px] [&_svg]:size-3"
                                icon={column.plugin.icon}
                              />
                              <span className="mt-1 line-clamp-2 min-h-[23px] w-full break-words">
                                {column.name}
                              </span>
                              <span className="mt-0.5 text-foreground tabular-nums">{holders}</span>
                            </button>
                          }
                        />
                      </th>
                    )
                  })}
                  <th className="border-b border-foreground/[0.09] p-0 pb-1 pl-2 align-top font-normal">
                    {/* Where a table grows: the next column. */}
                    <button
                      aria-label="Add plugin"
                      className="hex-focus mx-auto flex w-[44px] flex-col items-center rounded-[8px] py-1 text-[10px] leading-[1.15] text-muted transition-colors duration-[var(--hex-motion-fast)] hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-foreground!"
                      data-cell="head/add"
                      data-col="add"
                      onClick={() => add({ at: 'pick' })}
                      tabIndex={grid.tab('head/add') ? 0 : -1}
                      title="Add plugin"
                      type="button"
                    >
                      <span className="grid size-[22px] place-items-center rounded-[7px] border-[1.5px] border-dashed border-foreground/35">
                        <Plus size={13} />
                      </span>
                      <span className="mt-1">Add</span>
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => {
                  const many = row.bots.length > 1
                  const head = row.bots[0]!
                  const isOpen = many && open.includes(row.id)
                  const name = groupName(row.bots)
                  const inside = full.includes(row.id) ? row.bots : row.bots.slice(0, STEP)

                  return (
                    <Fragment key={row.id}>
                      <tr className="hex-grid-row">
                        <th
                          className={cn(
                            pinnedCell,
                            'py-0.5 pr-2 pl-4 text-left font-medium',
                            !isOpen && 'border-b border-foreground/[0.07]'
                          )}
                          scope="row"
                        >
                          <span className="flex items-center gap-2 whitespace-nowrap">
                            {tickBox(row.bots, row.id, name)}
                            {many ? (
                              <button
                                aria-expanded={isOpen}
                                aria-label={`${name}, ${isOpen ? 'hide' : 'show'} them`}
                                className="hex-focus flex min-h-8 min-w-0 items-center gap-2 rounded-[8px] text-left focus-visible:outline-foreground!"
                                data-cell={`${row.id}/name`}
                                data-col="name"
                                onClick={() =>
                                  setOpen(isOpen ? open.filter(id => id !== row.id) : [...open, row.id])
                                }
                                tabIndex={grid.tab(`${row.id}/name`, first === `${row.id}/name`) ? 0 : -1}
                                type="button"
                              >
                                <ChevronRight
                                  className={cn('shrink-0 text-muted transition-transform', isOpen && 'rotate-90')}
                                  size={14}
                                />
                                <Faces bots={row.bots} />
                                {name}
                              </button>
                            ) : (
                              <>
                                <span className="w-[14px] shrink-0" />
                                {botLink(head, row.id)}
                                <span className="hidden text-[length:var(--text-meta)] font-normal text-muted @min-[600px]:inline">
                                  {head.primary ? 'Primary bot' : labelOf(head)}
                                </span>
                              </>
                            )}
                          </span>
                        </th>
                        {cells(row.bots, row.id, name, !isOpen)}
                        <td className={isOpen ? undefined : 'border-b border-foreground/[0.07]'} />
                      </tr>
                      {isOpen ? (
                        <>
                          {inside.map((bot, index) => (
                            <tr
                              className="hex-grid-row hex-fade"
                              key={bot.name}
                              // Each a beat after the last, so the group opens downwards.
                              style={{ animationDelay: `${Math.min(index, 14) * 14}ms` }}
                            >
                              <th className={cn(pinnedCell, 'py-0 pr-2 pl-[62px] text-left font-normal')} scope="row">
                                {botLink(bot, `bot:${bot.name}`, 'text-[length:var(--text-secondary)]')}
                              </th>
                              {cells([bot], `bot:${bot.name}`, bot.display_name)}
                              <td />
                            </tr>
                          ))}
                          <tr>
                            <td className={cn(pinnedCell, 'border-b border-foreground/[0.07] py-1 pl-[54px]')}>
                              {row.bots.length > inside.length ? (
                                <Button onClick={() => setFull([...full, row.id])} size="sm" variant="ghost">
                                  Show all {row.bots.length}
                                </Button>
                              ) : null}
                            </td>
                            <td className="border-b border-foreground/[0.07]" colSpan={shownColumns.length + 1} />
                          </tr>
                        </>
                      ) : null}
                    </Fragment>
                  )
                })}
                {rows.length ? null : (
                  <tr>
                    <td className="px-4 py-8 text-center text-muted" colSpan={shownColumns.length + 2}>
                      No bot matches. Clear the search or the filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {!folded && shown.length > limit ? (
              <div className="sticky left-0 flex items-center gap-3 px-4 py-2.5 text-[length:var(--text-secondary)] text-muted">
                Showing {limit} of {shown.length} bots.
                <Button onClick={() => setLimit(limit + PAGE)} size="sm">
                  Show {Math.min(PAGE, shown.length - limit)} more
                </Button>
                <Button onClick={() => setLimit(shown.length)} size="sm" variant="ghost">
                  Show all
                </Button>
              </div>
            ) : null}
          </div>
          {stale ? (
            <p className="mt-2 flex flex-wrap items-center gap-2 px-1 text-[length:var(--text-meta)] text-muted">
              Rows are grouped as they were before your last change, so none moved.
              <Button onClick={regroup} size="sm" variant="ghost">
                Group again
              </Button>
            </p>
          ) : null}
          <ChangeBar
            data={data}
            hint="A tick is a grant, a dash means only some of the row have it. Arrow keys move, Space changes a box, and a column's heading opens the plugin or filters by it."
          >
            {warned && flips.length ? (
              <span className="w-full text-[length:var(--text-secondary)] font-medium" role="alert">
                These changes are not applied. Review or discard them, or press Escape again to close
                Settings and keep them for later.
              </span>
            ) : null}
            {tickedBots.length ? (
              <span className="flex flex-wrap items-center gap-1.5 border-r border-foreground/[0.1] pr-3">
                <span className="text-[length:var(--text-secondary)] font-medium">
                  {count(tickedBots.length, 'bot')} ticked
                </span>
                <Menu
                  items={bulk(
                    tickedBots.map(bot => bot.name),
                    true
                  )}
                  trigger={<Button size="sm">Give</Button>}
                />
                <Menu
                  items={bulk(
                    tickedBots.map(bot => bot.name),
                    false
                  )}
                  trigger={<Button size="sm">Take away</Button>}
                />
                <Button aria-label="Untick all" onClick={() => setTicked([])} size="icon" variant="ghost">
                  <X size={14} />
                </Button>
              </span>
            ) : null}
          </ChangeBar>
        </>
      )}
      <BotSheet data={data} />
      <AddPlugin data={data} />
      {opened ? (
        // Grants are the table's to give, so the window holds only the plugin
        // itself. Discord is the exception: each bot connects its own app there.
        <PluginSheet
          bots={isDiscord(opened) ? bots : []}
          focus={null}
          onClose={() => setSheet(null)}
          plugin={opened}
        />
      ) : null}
    </div>
  )
}
