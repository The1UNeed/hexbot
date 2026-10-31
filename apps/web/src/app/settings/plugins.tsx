import { ChevronDown, Plus, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { Button } from '../../components/ui/button'
import { confirm } from '../../components/ui/confirm'
import { ConnectorIcon } from '../../components/ui/connector-icon'
import { Input } from '../../components/ui/input'
import { SkeletonLines } from '../../components/ui/skeleton'
import { Switch } from '../../components/ui/switch'
import { Textarea } from '../../components/ui/textarea'
import {
  connectorsClear,
  connectorsRemoveMcp,
  connectorsTest,
  type PluginInstallInput,
  skillsSetGlobal
} from '../../lib/api'
import { cn } from '../../lib/cn'
import type { Plugin, PluginValue } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useConnection } from '../../stores/connection'
import { usePlugins } from '../../stores/plugins'
import { ConnectorSetupSheet } from '../bot-settings/connector-setup'
import { errorText, fieldLabel, Group, Heading } from '../bot-settings/shared'

const CONNECTOR_GROUPS: { id: string; title: string }[] = [
  { id: 'search', title: 'Search and browsing' },
  { id: 'media', title: 'Images and voice' },
  { id: 'work', title: 'Notes and work' },
  { id: 'social_home', title: 'Social and home' }
]

/** `software-development` reads as "Software development". */
const categoryTitle = (category: string) => {
  const words = category.replace(/[-_]+/g, ' ').trim()

  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Other'
}

/** A bot as the page names it. */
interface PluginBot {
  display_name: string
  name: string
}

const keyOf = (plugin: Plugin) => `${plugin.kind}:${plugin.id}`

/** Who a plugin is on for, in a few words. */
function botsText(plugin: Plugin, bots: PluginBot[]): string {
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
      'Services Hexbot supports. Keys are stored once on this daemon; each bot you turn one on for uses them.',
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
        .map(bot => ({ display_name: bot.display_name || bot.name, name: bot.name })),
    [byName, order]
  )

  const plugins = usePlugins(state => state.plugins)
  const loading = usePlugins(state => state.loading)
  const loadError = usePlugins(state => state.error)
  const refresh = usePlugins(state => state.refresh)
  const [category, setCategory] = useState<Category>('connectors')
  const [query, setQuery] = useState('')
  const [focus, setFocus] = useState<null | string>(null)
  const [expanded, setExpanded] = useState<null | string>(null)
  const [sheet, setSheet] = useState<null | string>(null)
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

  // A bot that was deleted while it was chosen falls back to every bot.
  const focused = bots.find(bot => bot.name === focus) ?? null
  const current = CATEGORIES.find(item => item.id === category)!

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()

    return plugins.filter(
      item =>
        categoryOf(item) === category &&
        (!needle ||
          `${item.name} ${item.description} ${item.category}`.toLowerCase().includes(needle))
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
  const sheetPlugin = plugins.find(item => keyOf(item) === sheet)?.connector

  const row = (plugin: Plugin) => (
    <PluginRow
      bots={bots}
      expanded={expanded === keyOf(plugin)}
      focus={focused}
      key={keyOf(plugin)}
      onExpand={() => setExpanded(expanded === keyOf(plugin) ? null : keyOf(plugin))}
      onSetup={() => setSheet(keyOf(plugin))}
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
        className="mb-5 flex gap-6 border-b border-foreground/[0.08]"
        role="tablist"
      >
        {CATEGORIES.map(item => (
          <button
            aria-controls="plugins-panel"
            aria-selected={category === item.id}
            className={cn(
              'hex-focus -mb-px flex h-9 items-center gap-1.5 border-b-2 text-[length:var(--text-body)] transition-colors duration-[var(--hex-motion-fast)]',
              category === item.id
                ? 'border-foreground font-medium text-foreground'
                : 'border-transparent text-muted hover:text-foreground'
            )}
            key={item.id}
            onClick={() => {
              setCategory(item.id)
              setExpanded(null)
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
                  'h-[30px] rounded-full px-3 text-[length:var(--text-secondary)] whitespace-nowrap transition-colors',
                  (focused?.name ?? null) === (bot?.name ?? null)
                    ? 'bg-foreground text-background'
                    : 'bg-foreground/[0.07] text-foreground hover:bg-foreground/[0.11]'
                )}
                key={bot?.name ?? ''}
                onClick={() => setFocus(bot?.name ?? null)}
                role="tab"
                type="button"
              >
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
        <div className="space-y-6" id="plugins-panel" role="tabpanel">
          {category === 'connectors'
            ? CONNECTOR_GROUPS.map(group => {
                const rows = visible.filter(item => item.category === group.id)

                return rows.length ? (
                  <Group key={group.id} title={group.title}>
                    {rows.map(row)}
                  </Group>
                ) : null
              })
            : null}
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
      {sheetPlugin ? (
        <ConnectorSetupSheet
          connector={sheetPlugin}
          onClose={() => {
            setSheet(null)
            void refresh()
          }}
        />
      ) : null}
    </>
  )
}

function PluginRow({
  bots,
  expanded,
  focus,
  onExpand,
  onSetup,
  plugin
}: {
  bots: PluginBot[]
  expanded: boolean
  focus: null | PluginBot
  onExpand: () => void
  onSetup: () => void
  plugin: Plugin
}) {
  const setBots = usePlugins(state => state.setBots)
  const [error, setError] = useState<null | string>(null)

  const choose = (next: string[]) => {
    setError(null)
    void setBots(plugin, next).catch(cause => setError(errorText(cause)))
  }

  const toggle = (bot: string, on: boolean) =>
    choose(on ? [...plugin.bots, bot] : plugin.bots.filter(name => name !== bot))

  // A connector or skill can be ready for one bot through a key in its own
  // `.env`, so only the daemon can tell whether a bot may have it.
  const control = focus ? (
    <Switch
      aria-label={`${plugin.name} for ${focus.display_name}`}
      checked={plugin.bots.includes(focus.name)}
      onCheckedChange={on => toggle(focus.name, on)}
    />
  ) : (
    <span className="shrink-0 text-[length:var(--text-secondary)] text-muted">
      {botsText(plugin, bots)}
    </span>
  )

  return (
    <div data-testid={`plugin-${keyOf(plugin)}`}>
      <div className="flex min-h-[56px] items-center gap-3 px-4 py-2.5">
        <ConnectorIcon icon={plugin.icon} />
        <button
          aria-expanded={expanded}
          className="min-w-0 flex-1 text-left outline-none"
          onClick={onExpand}
          type="button"
        >
          <span className="flex items-baseline gap-2">
            <span>{plugin.name}</span>
            <span
              className={cn(
                'min-w-0 truncate text-[length:var(--text-meta)]',
                plugin.state === 'error'
                  ? 'text-danger'
                  : plugin.state === 'not_set_up' && plugin.kind !== 'connector'
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
        </button>
        {control}
        <ChevronDown
          aria-hidden
          className={cn(
            'shrink-0 text-muted transition-transform duration-[var(--hex-motion-fast)]',
            expanded && 'rotate-180'
          )}
          size={15}
        />
      </div>
      {error && !expanded ? (
        <p
          className="px-4 pb-3 pl-[56px] text-[length:var(--text-secondary)] text-danger"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {expanded ? (
        <div className="hex-fade grid gap-4 px-4 pt-1 pb-4 pl-[56px] text-[length:var(--text-secondary)]">
          {bots.length ? (
            <BotPicker bots={bots} chosen={plugin.bots} name={plugin.name} onChange={choose} />
          ) : null}
          {error ? (
            <p className="text-danger" role="alert">
              {error}
            </p>
          ) : null}
          <PluginDetails bots={bots} onSetup={onSetup} plugin={plugin} />
        </div>
      ) : null}
    </div>
  )
}

/** One pill per bot; a filled pill is on. */
function BotPicker({
  bots,
  chosen,
  name,
  onChange
}: {
  bots: PluginBot[]
  chosen: string[]
  name: string
  onChange: (bots: string[]) => void
}) {
  const all = bots.every(bot => chosen.includes(bot.name))

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-3">
        <span className="text-muted">Bots</span>
        {bots.length > 1 ? (
          <button
            className="text-[length:var(--text-meta)] text-muted underline-offset-2 hover:text-foreground hover:underline disabled:pointer-events-none disabled:opacity-50"
            onClick={() => onChange(all ? [] : bots.map(bot => bot.name))}
            type="button"
          >
            {all ? 'Turn off for every bot' : 'Turn on for every bot'}
          </button>
        ) : null}
      </div>
      <div aria-label={`Bots that use ${name}`} className="flex flex-wrap gap-1.5" role="group">
        {bots.map(bot => {
          const on = chosen.includes(bot.name)

          return (
            <button
              aria-pressed={on}
              className={cn(
                'h-[30px] rounded-full px-3 whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50',
                on
                  ? 'bg-accent text-accent-fg'
                  : 'bg-foreground/[0.07] text-foreground hover:bg-foreground/[0.11]'
              )}
              key={bot.name}
              onClick={() =>
                onChange(on ? chosen.filter(item => item !== bot.name) : [...chosen, bot.name])
              }
              type="button"
            >
              {bot.display_name}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function PluginDetails({
  bots,
  onSetup,
  plugin
}: {
  bots: PluginBot[]
  onSetup: () => void
  plugin: Plugin
}) {
  const refresh = usePlugins(state => state.refresh)
  const remove = usePlugins(state => state.remove)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<null | { ok: boolean; text: string }>(null)
  const connector = plugin.connector

  const run = (action: () => Promise<unknown>) => {
    setBusy(true)
    setMessage(null)
    void action()
      .catch(cause => setMessage({ ok: false, text: errorText(cause) }))
      .finally(() => setBusy(false))
  }

  const test = () =>
    run(async () => {
      const result = await connectorsTest(connector!.id)

      setMessage({ ok: result.ok, text: result.message })
      await refresh()
    })

  // A server added on its own; a package goes with its server and skills.
  const looseServer = plugin.kind === 'connector' && Boolean(plugin.server)
  const removable = plugin.kind === 'package' || looseServer

  return (
    <>
      {plugin.kind === 'connector' && connector?.fields.length ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          {connector.fields
            .filter(field => !field.provider || field.provider === connector.provider)
            .map(field => (
              <div className="contents" key={field.key}>
                <dt className="text-muted">{field.label}</dt>
                <dd>{field.set ? (field.hint ? `Saved ${field.hint}` : 'Saved') : 'Not set'}</dd>
              </div>
            ))}
        </dl>
      ) : null}
      {plugin.server ? (
        <p className="font-mono break-all text-muted">
          {plugin.server.url ?? [plugin.server.command, ...(plugin.server.args ?? [])].join(' ')}
        </p>
      ) : null}
      {plugin.server ? <ServerValues plugin={plugin} /> : null}
      {plugin.skills?.length ? (
        <div>
          <p className="mb-1 text-muted">Skills</p>
          <ul className="grid gap-1">
            {plugin.skills.map(skill => (
              <li key={skill.name}>
                <span className="font-medium">{skill.name}</span>
                {skill.description ? (
                  <span className="text-muted"> · {skill.description}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {plugin.installed_by ? (
        <p className="text-muted">
          Asked for by{' '}
          {bots.find(bot => bot.name === plugin.installed_by)?.display_name ?? plugin.installed_by}.
        </p>
      ) : null}
      {plugin.kind === 'skill' ? (
        <p className="text-muted">
          {plugin.disabled_globally
            ? 'Off for every bot in Settings, whatever its switch here says.'
            : plugin.source === 'bundled'
              ? 'Comes with Hexbot.'
              : 'In your skill library.'}
        </p>
      ) : null}
      {message ? (
        <p
          className={message.ok ? 'text-success' : 'text-danger'}
          role={message.ok ? 'status' : 'alert'}
        >
          {message.text}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {plugin.kind === 'skill' && plugin.disabled_globally ? (
          <Button
            busy={busy}
            onClick={() => run(() => skillsSetGlobal(plugin.id, true).then(refresh))}
            size="sm"
            variant="primary"
          >
            Undo Off for every bot
          </Button>
        ) : null}
        {plugin.kind === 'connector' && connector?.fields.length ? (
          <Button onClick={onSetup} size="sm">
            {plugin.state === 'not_set_up' ? 'Set up' : 'Edit'}
          </Button>
        ) : null}
        {connector && (plugin.kind !== 'connector' || plugin.state !== 'not_set_up') ? (
          <Button busy={busy} onClick={test} size="sm">
            Test
          </Button>
        ) : null}
        {plugin.kind === 'connector' &&
        plugin.state !== 'not_set_up' &&
        connector?.fields.length ? (
          <Button
            onClick={() =>
              void confirm({ title: `Remove the keys for ${plugin.name}?` }).then(yes =>
                yes ? run(() => connectorsClear(plugin.id).then(refresh)) : undefined
              )
            }
            size="sm"
            variant="ghost"
          >
            Remove keys
          </Button>
        ) : null}
        {removable ? (
          <Button
            onClick={() =>
              void confirm({ title: `Remove ${plugin.name} for every bot?` }).then(yes =>
                yes
                  ? run(() =>
                      looseServer ? connectorsRemoveMcp(plugin.name).then(refresh) : remove(plugin)
                    )
                  : undefined
              )
            }
            size="sm"
            variant="ghost"
          >
            Remove
          </Button>
        ) : null}
      </div>
    </>
  )
}

/** An MCP server's environment (a command) or headers (a URL), set one name at a time. */
function ServerValues({ plugin }: { plugin: Plugin }) {
  const configure = usePlugins(state => state.configure)
  const server = plugin.server!
  const kind = server.transport === 'http' ? 'headers' : 'env'
  const values: PluginValue[] = server[kind]
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)

  const save = (change: Record<string, null | string>) => {
    setBusy(true)
    setError(null)
    void configure(plugin, { [kind]: change })
      .then(() => {
        setDrafts({})
        setNewKey('')
        setNewValue('')
      })
      .catch(cause => setError(errorText(cause)))
      .finally(() => setBusy(false))
  }

  const changed = Object.fromEntries(Object.entries(drafts).filter(([, value]) => value.trim()))
  const label = kind === 'headers' ? 'Headers' : 'Environment'

  return (
    <form
      className="grid gap-2"
      onSubmit={event => {
        event.preventDefault()
        const change: Record<string, string> = { ...changed }

        if (newKey.trim()) {
          change[newKey.trim()] = newValue
        }

        save(change)
      }}
    >
      <span className="text-muted">{label}</span>
      {values.map(value => (
        <div className="flex items-center gap-2" key={value.key}>
          <span className="w-44 shrink-0 truncate font-mono" title={value.key}>
            {value.key}
          </span>
          <Input
            aria-label={`${value.key} for ${plugin.name}`}
            autoComplete="off"
            className="min-w-0 flex-1"
            onChange={event => setDrafts({ ...drafts, [value.key]: event.target.value })}
            placeholder={value.set ? (value.hint ? `Saved ${value.hint}` : 'Saved') : 'Not set'}
            type="password"
            value={drafts[value.key] ?? ''}
          />
          <button
            aria-label={`Remove ${value.key}`}
            className="grid size-8 shrink-0 place-items-center rounded-full text-muted hover:bg-foreground/[0.07] hover:text-foreground"
            onClick={() => save({ [value.key]: null })}
            type="button"
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Input
          aria-label={`New ${kind === 'headers' ? 'header' : 'environment'} name`}
          autoComplete="off"
          className="w-44 shrink-0 font-mono"
          onChange={event => setNewKey(event.target.value)}
          placeholder={kind === 'headers' ? 'Authorization' : 'API_TOKEN'}
          value={newKey}
        />
        <Input
          aria-label="New value"
          autoComplete="off"
          className="min-w-0 flex-1"
          onChange={event => setNewValue(event.target.value)}
          placeholder="Value"
          type="password"
          value={newValue}
        />
        <span className="size-8 shrink-0" />
      </div>
      {error ? (
        <p className="text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <div>
        <Button
          busy={busy}
          disabled={!Object.keys(changed).length && !newKey.trim()}
          size="sm"
          type="submit"
        >
          Save values
        </Button>
      </div>
    </form>
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
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
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
