import { ChevronDown, Plus, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { Button } from '../../components/ui/button'
import { ConnectorIcon } from '../../components/ui/connector-icon'
import { Input } from '../../components/ui/input'
import { SkeletonLines } from '../../components/ui/skeleton'
import { Switch } from '../../components/ui/switch'
import { connectorsTest } from '../../lib/api'
import { cn } from '../../lib/cn'
import type { Bot, Connector, ConnectorGroup } from '../../lib/types'
import { useConnectors, useConnectorsForBot } from '../../stores/connectors'

import { ConnectorSetupSheet } from './connector-setup'
import { errorText, fieldLabel, formatTimestamp, Group, Heading } from './shared'

const GROUPS: { id: ConnectorGroup; title: string }[] = [
  { id: 'search', title: 'Search and browsing' },
  { id: 'media', title: 'Images and voice' },
  { id: 'work', title: 'Notes and work' },
  { id: 'social_home', title: 'Social and home' },
  { id: 'mcp', title: 'Connected tools' }
]

type Filter = 'all' | 'needs_setup' | 'on'

const FILTERS: { id: Filter; label: (bot: Bot) => string }[] = [
  { id: 'all', label: () => 'All' },
  { id: 'on', label: bot => `On for ${bot.display_name}` },
  { id: 'needs_setup', label: () => 'Needs setup' }
]

export function ConnectorsTab({ bot, initialConnector }: { bot: Bot; initialConnector?: string }) {
  const connectors = useConnectorsForBot(bot.name)
  const loading = useConnectors(state => state.loading)
  const storeError = useConnectors(state => state.error)
  const refresh = useConnectors(state => state.refresh)
  const setForBot = useConnectors(state => state.setForBot)
  const clear = useConnectors(state => state.clear)
  const removeMcp = useConnectors(state => state.removeMcp)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [sheet, setSheet] = useState<string | null>(initialConnector ?? null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void refresh(bot.name)
  }, [bot.name, refresh])
  useEffect(() => setSheet(initialConnector ?? null), [initialConnector])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()

    return connectors.filter(item => {
      if (needle && !`${item.name} ${item.description}`.toLowerCase().includes(needle)) {
        return false
      }

      if (filter === 'on') {
        return Boolean(item.enabled_for_bot)
      }

      if (filter === 'needs_setup') {
        return item.state !== 'ready'
      }

      return true
    })
  }, [connectors, filter, query])

  const sheetConnector = connectors.find(item => item.id === sheet)

  const act = (promise: Promise<unknown>) => {
    setError(null)
    void promise.catch(cause => setError(errorText(cause)))
  }

  return (
    <div>
      <Heading description="Services this bot can reach. Keys are stored once on this daemon and shared by every bot.">
        Connectors
      </Heading>
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted"
            size={15}
          />
          <Input
            aria-label="Search connectors"
            className="rounded-full pl-9"
            onChange={event => setQuery(event.target.value)}
            placeholder="Search connectors"
            value={query}
          />
        </label>
        <div className="flex gap-1.5" role="tablist">
          {FILTERS.map(item => (
            <button
              aria-selected={filter === item.id}
              className={cn(
                'h-[30px] rounded-full px-3 text-[length:var(--text-secondary)] whitespace-nowrap transition-colors',
                filter === item.id
                  ? 'bg-foreground text-background'
                  : 'bg-foreground/[0.07] text-foreground hover:bg-foreground/[0.11]'
              )}
              key={item.id}
              onClick={() => setFilter(item.id)}
              role="tab"
              type="button"
            >
              {item.label(bot)}
            </button>
          ))}
        </div>
      </div>
      {storeError && !connectors.length ? (
        <p className="text-danger" role="alert">
          {storeError}
        </p>
      ) : null}
      {error ? (
        <p className="mb-3 text-[length:var(--text-secondary)] text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {loading && !connectors.length ? <SkeletonLines label="Loading connectors" /> : null}
      <div className="space-y-8">
        {GROUPS.map(group => {
          const rows = visible.filter(item => item.group === group.id)

          if (!rows.length && !(group.id === 'mcp' && filter === 'all' && !query)) {
            return null
          }

          return (
            <Group key={group.id} title={group.title}>
              {rows.map(item => (
                <ConnectorRow
                  bot={bot}
                  connector={item}
                  expanded={expanded === item.id}
                  key={item.id}
                  onClear={() => act(clear(bot.name, item.id))}
                  onExpand={() => setExpanded(expanded === item.id ? null : item.id)}
                  onRemove={
                    item.group === 'mcp'
                      ? () => act(removeMcp(bot.name, item.id.replace(/^mcp:/, '')))
                      : undefined
                  }
                  onSetup={() => setSheet(item.id)}
                  onTest={() => connectorsTest(item.id, bot.name).then(() => refresh(bot.name))}
                  onToggle={enabled => act(setForBot(bot.name, item.id, enabled))}
                />
              ))}
              {group.id === 'mcp' ? (
                adding ? (
                  <AddMcpForm bot={bot} onDone={() => setAdding(false)} />
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
                )
              ) : null}
            </Group>
          )
        })}
      </div>
      {sheetConnector ? (
        <ConnectorSetupSheet bot={bot} connector={sheetConnector} onClose={() => setSheet(null)} />
      ) : null}
    </div>
  )
}

function ConnectorRow({
  bot,
  connector,
  expanded,
  onClear,
  onExpand,
  onRemove,
  onSetup,
  onToggle,
  onTest
}: {
  bot: Bot
  connector: Connector
  expanded: boolean
  onClear: () => void
  onExpand: () => void
  onRemove?: () => void
  onSetup: () => void
  onTest: () => Promise<void>
  onToggle: (enabled: boolean) => void
}) {
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)

  const control =
    !connector.mcp && connector.state === 'error' ? (
      <Button onClick={onSetup} size="sm" variant="primary">
        Fix
      </Button>
    ) : !connector.mcp && connector.state === 'not_set_up' ? (
      <Button onClick={onSetup} size="sm">
        Set up
      </Button>
    ) : (
      <Switch
        aria-label={`${connector.name} for ${bot.display_name}`}
        checked={Boolean(connector.enabled_for_bot)}
        onCheckedChange={onToggle}
      />
    )

  return (
    <div data-testid={`connector-${connector.id}`}>
      <div className="flex min-h-[56px] items-center gap-3 px-4 py-2.5">
        <ConnectorIcon icon={connector.icon} />
        <button
          aria-expanded={expanded}
          className="min-w-0 flex-1 text-left outline-none"
          onClick={onExpand}
          type="button"
        >
          <span className="flex items-baseline gap-2">
            <span>{connector.name}</span>
            <span
              className={cn(
                'min-w-0 truncate text-[length:var(--text-meta)]',
                connector.state === 'error' ? 'text-danger' : 'text-muted'
              )}
              title={connector.state_text}
            >
              {connector.state_text}
            </span>
          </span>
          <span className="mt-0.5 block truncate text-[length:var(--text-secondary)] text-muted">
            {connector.description}
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
      {expanded ? (
        <div className="hex-fade grid gap-3 px-4 pt-1 pb-4 pl-[56px] text-[length:var(--text-secondary)]">
          {connector.fields.length ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              {connector.fields.map(field => (
                <div className="contents" key={field.key}>
                  <dt className="text-muted">{field.label}</dt>
                  <dd>{field.set ? (field.hint ? `Saved ${field.hint}` : 'Saved') : 'Not set'}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {connector.mcp ? (
            <p className="text-muted">
              {connector.mcp.test_failed
                ? 'Test failed'
                : connector.mcp.tool_count === null
                  ? 'Not tested'
                  : `${connector.mcp.tool_count} tools`}{' '}
              · {connector.mcp.transport} · {connector.mcp.running ? 'running' : 'not running'}
            </p>
          ) : null}
          {connector.last_error ? (
            <p className="text-danger">
              {connector.last_error.text}
              <span className="text-muted"> · {formatTimestamp(connector.last_error.at)}</span>
            </p>
          ) : null}
          {testError ? <p className="text-danger">{testError}</p> : null}
          <div className="flex gap-2">
            {connector.mcp ? (
              <Button
                disabled={testing}
                onClick={() => {
                  setTesting(true)
                  setTestError(null)
                  void onTest()
                    .catch(cause => setTestError(errorText(cause)))
                    .finally(() => setTesting(false))
                }}
                size="sm"
              >
                {testing ? 'Testing…' : 'Test'}
              </Button>
            ) : null}
            {connector.fields.length ? (
              <Button onClick={onSetup} size="sm">
                {connector.state === 'not_set_up' ? 'Set up' : 'Edit'}
              </Button>
            ) : null}
            {connector.state !== 'not_set_up' && connector.fields.length ? (
              <Button onClick={onClear} size="sm" variant="ghost">
                Remove values
              </Button>
            ) : null}
            {onRemove ? (
              <Button
                onClick={() => {
                  if (
                    window.confirm(`Remove ${connector.name} from connected tools for every bot?`)
                  ) {
                    onRemove()
                  }
                }}
                size="sm"
                variant="ghost"
              >
                Remove server
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function AddMcpForm({ bot, onDone }: { bot: Bot; onDone: () => void }) {
  const addMcp = useConnectors(state => state.addMcp)
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isUrl = /^https?:\/\//i.test(target.trim())

  return (
    <form
      className="hex-fade grid gap-3 px-4 py-4"
      onSubmit={event => {
        event.preventDefault()
        setBusy(true)
        setError(null)
        const parts = target.trim().split(/\s+/)
        void addMcp(bot.name, {
          name: name.trim(),
          ...(isUrl
            ? { transport: 'http' as const, url: target.trim() }
            : { args: parts.slice(1), command: parts[0] ?? '' })
        })
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
