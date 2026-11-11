import { ChevronRight, Plus, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { Avatar } from '../../components/ui/avatar'
import { Button } from '../../components/ui/button'
import { ConnectorIcon } from '../../components/ui/connector-icon'
import { Input } from '../../components/ui/input'
import { SkeletonLines } from '../../components/ui/skeleton'
import { Switch } from '../../components/ui/switch'
import { Textarea } from '../../components/ui/textarea'
import type { PluginInstallInput } from '../../lib/api'
import { botFace } from '../../lib/avatar-builder'
import { cn } from '../../lib/cn'
import { canGive, CONNECTOR_SHELVES, isConnected, shelfOf } from '../../lib/plugin-rows'
import type { Bot, Plugin } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useConnection } from '../../stores/connection'
import { usePlugins } from '../../stores/plugins'
import { cardClass, errorText, fieldLabel, Group, Heading } from '../bot-settings/shared'

import { PluginSheet } from './plugin-sheet'

/** `software-development` reads as "Software development". */
const categoryTitle = (category: string) => {
  const words = category.replace(/[-_]+/g, ' ').trim()

  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Other'
}

const keyOf = (plugin: Plugin) => `${plugin.kind}:${plugin.id}`

/** Who a plugin is on for, in a few words. */
function botsText(plugin: Plugin, bots: Bot[]): string {
  const on = bots.filter(bot => plugin.bots.includes(bot.name))

  if (!bots.length || !on.length) {
    return 'Off'
  }

  if (on.length === bots.length) {
    return bots.length === 1 ? 'On' : 'Every bot'
  }

  if (on.length <= 2) {
    return on.map(bot => bot.display_name).join(' and ')
  }

  return `${on.length} bots`
}

type Category = 'connectors' | 'servers' | 'skills'

const CATEGORIES: {
  description: string
  empty: string
  id: Category
  label: string
  search: string
}[] = [
  {
    description:
      'Services your bots can work in. Connect one once on this daemon, then choose the bots that get it.',
    empty: 'No connector matches that.',
    id: 'connectors',
    label: 'Connectors',
    search: 'Search connectors'
  },
  {
    description:
      'Servers you or your bots add. A server can come with skills that explain it. A bot that needs one asks you first.',
    empty: 'No MCP server matches that.',
    id: 'servers',
    label: 'MCP servers',
    search: 'Search MCP servers'
  },
  {
    description:
      "Instructions bots follow for particular jobs. Skills a bot writes for itself stay in that bot's settings.",
    empty: 'No skill matches that.',
    id: 'skills',
    label: 'Skills',
    search: 'Search skills'
  }
]

const categoryOf = (plugin: Plugin): Category =>
  plugin.category === 'mcp' ? 'servers' : plugin.kind === 'connector' ? 'connectors' : 'skills'

export function PluginsSettings(): React.JSX.Element {
  const byName = useBots(state => state.byName)
  const order = useBots(state => state.order)

  // The primary bot first, then the others as the chat list orders them.
  const bots = useMemo(
    () =>
      order
        .map(name => byName[name])
        .filter(bot => bot !== undefined)
        .sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)))
        .map(bot => ({ ...bot, display_name: bot.display_name || bot.name })),
    [byName, order]
  )

  const plugins = usePlugins(state => state.plugins)
  const loading = usePlugins(state => state.loading)
  const loadError = usePlugins(state => state.error)
  const refresh = usePlugins(state => state.refresh)
  const [category, setCategory] = useState<Category>('connectors')
  const [query, setQuery] = useState('')
  const [focus, setFocus] = useState<null | string>(null)
  const [open, setOpen] = useState<null | string>(null)
  const [adding, setAdding] = useState(false)
  // Load again after any reconnect or a switch to another daemon.
  const target = useConnection(state => state.target)
  const epoch = useConnection(state => state.epoch)
  const connects = useConnection(state => state.connects)
  useEffect(() => {
    void refresh()

    // Events refresh the list only while this page is open.
    return () => usePlugins.setState({ loaded: false })
  }, [refresh, target, epoch, connects])

  // A tag in a message named a plugin or a skill: show its tab, searched for it.
  const sought = usePlugins(state => state.sought)
  const loaded = usePlugins(state => state.loaded)
  useEffect(() => {
    // Not before the list is in: the first visit starts with none.
    if (!sought || loading || !loaded) {
      return
    }

    const needle = sought.name.trim().toLowerCase()

    const found = plugins.find(
      item =>
        (sought.kind === 'skill') === (categoryOf(item) === 'skills') &&
        (item.name.toLowerCase() === needle || item.id.toLowerCase() === needle)
    )

    setCategory(found ? categoryOf(found) : sought.kind === 'skill' ? 'skills' : 'connectors')
    setQuery(found?.name ?? sought.name)
    usePlugins.setState({ sought: null })
  }, [loaded, loading, plugins, sought])

  // A bot that was deleted while it was chosen falls back to every bot.
  const focused = bots.find(bot => bot.name === focus) ?? null
  const current = CATEGORIES.find(item => item.id === category)!

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()

    return plugins.filter(
      item =>
        categoryOf(item) === category &&
        (!needle ||
          `${item.name} ${item.description} ${item.category} ${shelfOf(item)}`
            .toLowerCase()
            .includes(needle))
    )
  }, [category, plugins, query])

  const counts = useMemo(() => {
    const result: Record<Category, number> = { connectors: 0, servers: 0, skills: 0 }

    for (const item of plugins) {
      result[categoryOf(item)]++
    }

    return result
  }, [plugins])

  const skillPackages = visible.filter(item => item.kind === 'package')
  const skills = visible.filter(item => item.kind === 'skill')
  const skillCategories = [...new Set(skills.map(item => item.category))].sort()
  const connected = visible.filter(isConnected)
  const opened = plugins.find(item => keyOf(item) === open)

  const row = (plugin: Plugin) => (
    <PluginRow
      bots={bots}
      focus={focused}
      key={keyOf(plugin)}
      onOpen={() => setOpen(keyOf(plugin))}
      plugin={plugin}
    />
  )

  const card = (plugin: Plugin) => (
    <ConnectorCard
      bots={bots}
      focus={focused}
      key={keyOf(plugin)}
      onOpen={() => setOpen(keyOf(plugin))}
      plugin={plugin}
    />
  )

  return (
    <>
      <Heading description="Connectors, MCP servers and skills your bots can use. Choose which bots get each one.">
        Plugins
      </Heading>
      <div
        aria-label="Plugin kinds"
        // The same pill segments as the bot panel's tabs: no rule underneath.
        className="mb-5 flex w-fit max-w-full gap-0.5 rounded-full bg-foreground/[0.05] p-[3px]"
        role="tablist"
      >
        {CATEGORIES.map(item => (
          <button
            aria-controls="plugins-panel"
            aria-selected={category === item.id}
            className={cn(
              'hex-focus flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[length:var(--text-secondary)] font-medium whitespace-nowrap transition-colors duration-[var(--hex-motion-fast)]',
              category === item.id
                ? 'bg-background text-foreground shadow-card'
                : 'text-muted hover:text-foreground'
            )}
            key={item.id}
            onClick={() => {
              setCategory(item.id)
              setAdding(false)
            }}
            role="tab"
            type="button"
          >
            {item.label}
            {plugins.length ? (
              <span className="text-[length:var(--text-meta)] font-normal text-muted tabular-nums">
                {counts[item.id]}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <p className="-mt-1 mb-4 text-[length:var(--text-secondary)] text-muted">
        {current.description}
      </p>
      <div className="mb-6 grid gap-3">
        <label className="relative block">
          <Search
            className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted"
            size={15}
          />
          <Input
            aria-label={current.search}
            className="rounded-full pl-9"
            onChange={event => setQuery(event.target.value)}
            placeholder={current.search}
            value={query}
          />
        </label>
        {bots.length > 1 ? (
          <div aria-label="Show plugins for" className="flex flex-wrap gap-1.5" role="tablist">
            {[null, ...bots].map(bot => (
              <button
                aria-selected={(focused?.name ?? null) === (bot?.name ?? null)}
                className={cn(
                  'flex h-[30px] items-center gap-1.5 rounded-full text-[length:var(--text-secondary)] whitespace-nowrap transition-colors',
                  bot ? 'pr-3 pl-1.5' : 'px-3',
                  (focused?.name ?? null) === (bot?.name ?? null)
                    ? 'bg-foreground text-background'
                    : 'bg-foreground/[0.07] text-foreground hover:bg-foreground/[0.11]'
                )}
                key={bot?.name ?? ''}
                onClick={() => setFocus(bot?.name ?? null)}
                role="tab"
                type="button"
              >
                {bot ? (
                  <span aria-hidden className="inline-flex">
                    <Avatar {...botFace(bot)} name={bot.display_name} size="sm" />
                  </span>
                ) : null}
                {bot ? bot.display_name : 'Every bot'}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {loadError && !plugins.length ? (
        <p className="text-danger" role="alert">
          {loadError}
        </p>
      ) : null}
      {loading && !plugins.length ? <SkeletonLines label="Loading plugins" /> : null}
      {plugins.length ? (
        <div className="space-y-8" id="plugins-panel" role="tabpanel">
          {category === 'connectors' ? (
            <>
              {connected.length ? (
                <Shelf
                  description={
                    focused
                      ? `Switch each one on or off for ${focused.display_name}.`
                      : 'Open one to choose its bots, test it or disconnect it.'
                  }
                  title="Connected"
                >
                  {connected.map(card)}
                </Shelf>
              ) : null}
              {CONNECTOR_SHELVES.map(shelf => {
                const rows = visible.filter(
                  item => !isConnected(item) && shelfOf(item) === shelf.id
                )

                return rows.length ? (
                  <Shelf description={shelf.description} key={shelf.id} title={shelf.title}>
                    {rows.map(card)}
                  </Shelf>
                ) : null
              })}
            </>
          ) : null}
          {category === 'servers' ? (
            <Group>
              {visible.map(row)}
              {adding ? (
                <AddServerForm onDone={() => setAdding(false)} />
              ) : (
                <button
                  className="flex min-h-[52px] w-full items-center gap-3 px-4 py-2.5 text-left text-muted transition-colors hover:text-foreground"
                  onClick={() => setAdding(true)}
                  type="button"
                >
                  <span className="inline-flex size-7 items-center justify-center rounded-[8px] bg-foreground/[0.07]">
                    <Plus size={16} />
                  </span>
                  Add MCP server
                </button>
              )}
            </Group>
          ) : null}
          {category === 'skills' ? (
            <>
              {skillPackages.length ? (
                <Group title="Skill packages">{skillPackages.map(row)}</Group>
              ) : null}
              {skillCategories.map(name => (
                <Group key={name} title={categoryTitle(name)}>
                  {skills.filter(item => item.category === name).map(row)}
                </Group>
              ))}
            </>
          ) : null}
          {!visible.length && (category !== 'servers' || query.trim()) ? (
            <p className="px-1 text-[length:var(--text-secondary)] text-muted">
              {query.trim() ? current.empty : 'Nothing here yet.'}
            </p>
          ) : null}
        </div>
      ) : null}
      {opened ? (
        <PluginSheet bots={bots} focus={focused} onClose={() => setOpen(null)} plugin={opened} />
      ) : null}
    </>
  )
}

/** A titled grid of connector cards. */
function Shelf({
  children,
  description,
  title
}: {
  children: React.ReactNode
  description?: string
  title: string
}) {
  return (
    <section aria-label={title}>
      <div className="mb-3 px-1">
        <h3 className="text-[length:var(--text-body)] font-semibold">{title}</h3>
        {description ? (
          <p className="mt-0.5 text-[length:var(--text-secondary)] text-muted">{description}</p>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-3 @min-[640px]:grid-cols-2">{children}</div>
    </section>
  )
}

/** The faces of the bots a plugin is on for, with who they are in words. */
function BotStack({ bots, plugin }: { bots: Bot[]; plugin: Plugin }) {
  const on = bots.filter(bot => plugin.bots.includes(bot.name))

  if (!on.length) {
    return <span className="text-warning">No bot yet</span>
  }

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span aria-hidden className="flex shrink-0 -space-x-1">
        {on.slice(0, 3).map(bot => (
          <Avatar
            {...botFace(bot)}
            className="rounded-full ring-2 ring-[var(--hex-card,var(--hex-background))]"
            key={bot.name}
            name={bot.display_name}
            size="xs"
          />
        ))}
      </span>
      <span className="truncate">{botsText(plugin, bots)}</span>
    </span>
  )
}

/**
 * One connector as a card. Not connected, it says what it is for and offers
 * to connect it; connected, it shows its account and its bots. The whole
 * card opens its sheet; with a bot in view its switch sits on the card.
 */
function ConnectorCard({
  bots,
  focus,
  onOpen,
  plugin
}: {
  bots: Bot[]
  focus: Bot | null
  onOpen: () => void
  plugin: Plugin
}) {
  const setBots = usePlugins(state => state.setBots)
  const [error, setError] = useState<null | string>(null)
  const connected = isConnected(plugin)
  const account = Boolean(plugin.connector?.account)

  const toggle = (bot: string, on: boolean) => {
    setError(null)
    void setBots(
      plugin,
      on ? [...plugin.bots, bot] : plugin.bots.filter(name => name !== bot)
    ).catch(cause => setError(errorText(cause)))
  }

  const action =
    plugin.state === 'error' ? (
      <Button onClick={onOpen} size="sm" variant="primary">
        Fix
      </Button>
    ) : focus && (canGive(plugin, focus.name) || plugin.bots.includes(focus.name)) ? (
      <Switch
        aria-label={`${plugin.name} for ${focus.display_name}`}
        checked={plugin.bots.includes(focus.name)}
        onCheckedChange={on => toggle(focus.name, on)}
      />
    ) : !connected ? (
      <Button onClick={onOpen} size="sm">
        {account ? 'Connect' : 'Set up'}
      </Button>
    ) : null

  return (
    <div
      className={cn(
        cardClass,
        'relative flex min-h-[112px] flex-col gap-3 p-4 transition-shadow duration-[var(--hex-motion-fast)] focus-within:ring-2 focus-within:ring-foreground/20 hover:shadow-[var(--hex-card-shadow),0_4px_14px_rgb(0_0_0/0.06)]'
      )}
      data-testid={`plugin-${keyOf(plugin)}`}
    >
      <div className="flex items-start gap-3">
        <ConnectorIcon className="size-9" icon={plugin.icon} />
        <div className="min-w-0 flex-1">
          {/* The name is the button; its hit area is the whole card. */}
          <button
            className="block max-w-full truncate text-left text-[length:var(--text-body)] font-medium outline-none after:absolute after:inset-0 after:rounded-2xl"
            onClick={onOpen}
            type="button"
          >
            {plugin.name}
          </button>
          <p
            className={cn(
              'mt-0.5 text-[length:var(--text-secondary)]',
              connected ? 'truncate' : 'line-clamp-2',
              plugin.state === 'error' ? 'text-danger' : 'text-muted'
            )}
            title={connected ? plugin.state_text : undefined}
          >
            {connected ? plugin.state_text : plugin.description}
          </p>
        </div>
      </div>
      <div className="mt-auto flex min-h-[30px] items-center justify-between gap-3 text-[length:var(--text-secondary)] text-muted">
        {/* One that needs fixing says so; its bots wait until it works. */}
        {connected && plugin.state !== 'error' ? (
          <BotStack bots={bots} plugin={plugin} />
        ) : (
          <span />
        )}
        {/* Above the card's hit area, so the control takes its own clicks. */}
        {action ? <span className="relative z-10 shrink-0">{action}</span> : null}
      </div>
      {error ? (
        <p className="text-[length:var(--text-secondary)] text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** An MCP server or a skill as a row: its state, and its bots or a switch. */
function PluginRow({
  bots,
  focus,
  onOpen,
  plugin
}: {
  bots: Bot[]
  focus: Bot | null
  onOpen: () => void
  plugin: Plugin
}) {
  const setBots = usePlugins(state => state.setBots)
  const [error, setError] = useState<null | string>(null)

  const toggle = (bot: string, on: boolean) => {
    setError(null)
    void setBots(
      plugin,
      on ? [...plugin.bots, bot] : plugin.bots.filter(name => name !== bot)
    ).catch(cause => setError(errorText(cause)))
  }

  // Until it is set up, a plugin can be taken away from bots but not given,
  // except to a bot whose own settings hold its key.
  const control = focus ? (
    !canGive(plugin, focus.name) && !plugin.bots.includes(focus.name) ? (
      plugin.kind === 'skill' ? null : (
        <Button onClick={onOpen} size="sm">
          Set up
        </Button>
      )
    ) : (
      <Switch
        aria-label={`${plugin.name} for ${focus.display_name}`}
        checked={plugin.bots.includes(focus.name)}
        onCheckedChange={on => toggle(focus.name, on)}
      />
    )
  ) : (
    <span className="shrink-0 text-[length:var(--text-secondary)] text-muted">
      {botsText(plugin, bots)}
    </span>
  )

  return (
    <div data-testid={`plugin-${keyOf(plugin)}`}>
      <div className="relative flex min-h-[56px] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-foreground/[0.025]">
        <ConnectorIcon icon={plugin.icon} />
        <div className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            {/* The name is the button; its hit area is the whole row. */}
            <button
              className="truncate text-left outline-none after:absolute after:inset-0"
              onClick={onOpen}
              type="button"
            >
              {plugin.name}
            </button>
            <span
              className={cn(
                'min-w-0 truncate text-[length:var(--text-meta)]',
                plugin.state === 'error'
                  ? 'text-danger'
                  : plugin.state === 'not_set_up'
                    ? 'text-warning'
                    : 'text-muted'
              )}
              title={plugin.state_text}
            >
              {plugin.state_text}
            </span>
          </span>
          <span className="mt-0.5 block truncate text-[length:var(--text-secondary)] text-muted">
            {plugin.description}
          </span>
        </div>
        <span className="relative z-10 flex shrink-0 items-center">{control}</span>
        <ChevronRight aria-hidden className="shrink-0 text-muted" size={15} />
      </div>
      {error ? (
        <p
          className="px-4 pb-3 pl-[56px] text-[length:var(--text-secondary)] text-danger"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  )
}

function AddServerForm({ onDone }: { onDone: () => void }) {
  const install = usePlugins(state => state.install)
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const [description, setDescription] = useState('')
  const [skill, setSkill] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)
  const isUrl = /^https?:\/\//i.test(target.trim())

  return (
    <form
      className="hex-fade grid gap-3 px-4 py-4"
      onSubmit={event => {
        event.preventDefault()
        setBusy(true)
        setError(null)
        const plugin = name.trim()
        const parts = target.trim().split(/\s+/)

        const input: PluginInstallInput = {
          description: description.trim(),
          mcp: isUrl ? { url: target.trim() } : { args: parts.slice(1), command: parts[0] ?? '' },
          name: plugin
        }

        if (skill.trim()) {
          // JSON strings are valid YAML, so any description survives the frontmatter.
          const about = description.trim() || `How to use the ${plugin} MCP server.`

          input.skills = [
            {
              content: `---\ndescription: ${JSON.stringify(about)}\n---\n${skill.trim()}\n`,
              // Skill names stop at 64 characters, like plugin names.
              name: `${plugin.slice(0, 58)}-guide`
            }
          ]
        }

        void install(input)
          .then(onDone)
          .catch(cause => setError(errorText(cause)))
          .finally(() => setBusy(false))
      }}
    >
      <div className="grid gap-3 @min-[600px]:grid-cols-[12rem_1fr]">
        <label className="block">
          <span className={fieldLabel}>Name</span>
          <Input
            aria-label="MCP server name"
            autoFocus
            onChange={event => setName(event.target.value)}
            placeholder="github"
            value={name}
          />
        </label>
        <label className="block">
          <span className={fieldLabel}>Command or URL</span>
          <Input
            aria-label="MCP command or URL"
            className="font-mono text-[length:var(--text-secondary)]"
            onChange={event => setTarget(event.target.value)}
            placeholder="npx -y @modelcontextprotocol/server-github"
            value={target}
          />
        </label>
      </div>
      <label className="block">
        <span className={fieldLabel}>What it is for</span>
        <Input
          aria-label="What the server is for"
          onChange={event => setDescription(event.target.value)}
          placeholder="GitHub issues and pull requests"
          value={description}
        />
      </label>
      <label className="block">
        <span className={fieldLabel}>Skill for your bots (optional)</span>
        <Textarea
          aria-label="Skill for your bots"
          onChange={event => setSkill(event.target.value)}
          placeholder="How bots should use this server: which tools to call, in what order, what to avoid."
          rows={3}
          value={skill}
        />
      </label>
      <p className="text-[length:var(--text-meta)] text-muted">
        On for every bot. Add tokens under the server once it is added.
      </p>
      {error ? (
        <p className="text-[length:var(--text-secondary)] text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          busy={busy}
          disabled={!name.trim() || !target.trim()}
          size="sm"
          type="submit"
          variant="primary"
        >
          Add server
        </Button>
        <Button onClick={onDone} size="sm" variant="ghost">
          Cancel
        </Button>
      </div>
    </form>
  )
}
