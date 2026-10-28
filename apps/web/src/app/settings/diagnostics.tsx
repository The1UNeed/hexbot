import { ChevronDown, Copy } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import { Button } from '../../components/ui/button'
import { Chip } from '../../components/ui/chip'
import { Select } from '../../components/ui/select'
import { SkeletonLines } from '../../components/ui/skeleton'
import { diagnosticsGet, diagnosticsTrace, gatewayPing } from '../../lib/api'
import { cn } from '../../lib/cn'
import type {
  DiagnosticsCacheRow,
  DiagnosticsProcess,
  DiagnosticsSnapshot,
  DiagnosticsSpan,
  DiagnosticsStatement
} from '../../lib/types'
import { useBots } from '../../stores/bots'
import { unknownMethod } from '../../stores/me'
import { cardClass, dividerClass, Group, Heading, Row } from '../bot-settings/shared'

/** How often the open page asks the daemon again. The daemon samples every 5 s. */
export const POLL_MS = 5000

const VIEWS = [
  ['overview', 'Overview'],
  ['resources', 'Resources'],
  ['traces', 'Traces'],
  ['failures', 'Failures'],
  ['caches', 'Caches']
] as const

type View = (typeof VIEWS)[number][0]

/** Series colour by span kind; the legend under the waterfall names them. */
const KIND_COLOR: Record<DiagnosticsSpan['kind'], string> = {
  model: 'var(--hex-chart-2)',
  rpc: 'var(--hex-chart-5)',
  run: 'var(--hex-chart-1)',
  tool: 'var(--hex-chart-3)'
}

const KIND_LABEL: Record<DiagnosticsSpan['kind'], string> = {
  model: 'Model call',
  rpc: 'Request',
  run: 'Run',
  tool: 'Tool'
}

const FAILURE_KIND: Record<string, string> = {
  process: 'Bot process',
  rpc: 'Request',
  run: 'Run'
}

// --------------------------------------------------------------- formatting

export function formatMs(value: null | number | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return '—'
  }

  if (value < 1) {
    return `${value.toFixed(2)} ms`
  }

  if (value < 1000) {
    return `${Math.round(value)} ms`
  }

  if (value < 60_000) {
    return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} s`
  }

  return `${Math.floor(value / 60_000)} min ${Math.round((value % 60_000) / 1000)} s`
}

export function formatBytes(value: null | number | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return '—'
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unit = 0

  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }

  return `${size.toFixed(size >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

export function formatPercent(ratio: null | number | undefined): string {
  return ratio == null || !Number.isFinite(ratio) ? '—' : `${Math.round(ratio * 1000) / 10}%`
}

export function formatUptime(seconds: number): string {
  const s = Math.floor(seconds)

  if (s < 60) {
    return `${s} s`
  }

  if (s < 3600) {
    return `${Math.floor(s / 60)} min`
  }

  if (s < 86_400) {
    return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
  }

  return `${Math.floor(s / 86_400)} d ${Math.floor((s % 86_400) / 3600)} h`
}

const clock = (t: number) =>
  new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

const number = (value: number) => value.toLocaleString()

function ago(t: number, now: number): string {
  const seconds = Math.max(0, (now - t) / 1000)

  return seconds < 5 ? 'just now' : `${formatUptime(seconds)} ago`
}

/** Rounds a chart's top up to 1, 2 or 5 times a power of ten. */
function niceMax(value: number): number {
  if (value <= 0) {
    return 1
  }

  const power = 10 ** Math.floor(Math.log10(value))

  return ([1, 2, 5, 10].find(step => step * power >= value) ?? 10) * power
}

/** Load times of this window, read once from the browser. */
function windowTiming(): {
  firstPaint: null | number
  loaded: null | number
  ready: null | number
} {
  const navigation = performance.getEntriesByType?.('navigation')[0] as
    PerformanceNavigationTiming | undefined

  const paint = performance.getEntriesByName?.('first-contentful-paint')[0]

  return {
    firstPaint: paint ? paint.startTime : null,
    loaded: navigation?.loadEventEnd || null,
    ready: navigation?.domContentLoadedEventEnd || null
  }
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String((error as { message?: string })?.message ?? error)
}

// ------------------------------------------------------------------- polling

function useDiagnostics(spanName: string) {
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [roundTrip, setRoundTrip] = useState<null | number>(null)

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined

    const load = async () => {
      if (document.visibilityState !== 'hidden') {
        try {
          const started = performance.now()
          await gatewayPing()
          const trip = performance.now() - started
          const next = await diagnosticsGet(spanName || undefined)

          if (alive) {
            setSnapshot(next)
            setRoundTrip(trip)
            setError(null)
          }
        } catch (caught) {
          if (alive) {
            setError(caught)
          }
        }
      }

      if (alive) {
        timer = setTimeout(() => void load(), POLL_MS)
      }
    }

    void load()

    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [spanName])

  return { error, roundTrip, snapshot }
}

// ---------------------------------------------------------------- the page

export function DiagnosticsSettings(): React.JSX.Element {
  const [view, setView] = useState<View>('overview')
  const [spanName, setSpanName] = useState('')
  const [trace, setTrace] = useState<null | number>(null)
  const [copied, setCopied] = useState(false)
  const { error, roundTrip, snapshot } = useDiagnostics(spanName)

  const copy = async () => {
    if (!snapshot) {
      return
    }

    await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const openTrace = (id: number) => {
    setTrace(id)
    setView('traces')
  }

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <Heading description="What this daemon measured since it started. Updates every 5 seconds.">
          Diagnostics
        </Heading>
        {snapshot ? (
          <Button
            className="mt-0.5 shrink-0"
            icon={<Copy size={14} />}
            onClick={() => void copy()}
            size="sm"
          >
            {copied ? 'Copied' : 'Copy report'}
          </Button>
        ) : null}
      </div>
      <div aria-label="Diagnostics views" className="mb-6 flex flex-wrap gap-1" role="tablist">
        {VIEWS.map(([id, label]) => (
          <button
            aria-selected={view === id}
            className={cn(
              'h-7 rounded-full px-3 text-[length:var(--text-secondary)] transition-colors hex-focus',
              view === id
                ? 'bg-foreground text-background'
                : 'text-muted hover:bg-foreground/[0.06] hover:text-foreground'
            )}
            key={id}
            onClick={() => setView(id)}
            role="tab"
            type="button"
          >
            {label}
          </button>
        ))}
      </div>
      {snapshot ? (
        <div className="space-y-8" role="tabpanel">
          {error ? (
            <p
              className="rounded-[12px] bg-warning/10 px-4 py-3 text-[length:var(--text-secondary)] text-warning"
              role="status"
            >
              Showing the last report. {errorText(error)}
            </p>
          ) : null}
          {view === 'overview' && <Overview roundTrip={roundTrip} snapshot={snapshot} />}
          {view === 'resources' && <Resources snapshot={snapshot} />}
          {view === 'traces' && (
            <Traces
              onSpanName={setSpanName}
              onTrace={setTrace}
              snapshot={snapshot}
              spanName={spanName}
              trace={trace}
            />
          )}
          {view === 'failures' && <Failures onTrace={openTrace} snapshot={snapshot} />}
          {view === 'caches' && <Caches snapshot={snapshot} />}
        </div>
      ) : error ? (
        <p className="text-[length:var(--text-secondary)] text-muted" role="status">
          {unknownMethod(error)
            ? 'This daemon does not report diagnostics. Update it to see them here.'
            : `Diagnostics are unavailable: ${errorText(error)}`}
        </p>
      ) : (
        <SkeletonLines label="Loading diagnostics" lines={6} />
      )}
    </>
  )
}

// ----------------------------------------------------------------- overview

function Tile({ label, note, value }: { label: string; note?: string; value: string }) {
  return (
    <div className={cn(cardClass, 'min-w-0 px-4 py-3')}>
      <p className="text-[length:var(--text-meta)] font-medium text-muted">{label}</p>
      <p className="mt-1 truncate text-[22px] leading-7 font-semibold tracking-[-0.01em]">
        {value}
      </p>
      {note ? (
        <p className="mt-0.5 truncate text-[length:var(--text-meta)] text-muted">{note}</p>
      ) : null}
    </div>
  )
}

function Value({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[length:var(--text-secondary)] text-muted tabular-nums">
      {children}
    </span>
  )
}

const SUPERVISOR: Record<string, string> = {
  desktop: 'The Hexbot app',
  service: 'Background service'
}

function Overview({
  roundTrip,
  snapshot
}: {
  roundTrip: null | number
  snapshot: DiagnosticsSnapshot
}) {
  const [timing] = useState(windowTiming)
  const { caches, daemon, host, launch, load, resources } = snapshot
  const latest = resources.samples.at(-1)
  const prompt = 'error' in caches.prompt ? null : caches.prompt

  const span = Math.max(
    1,
    ...launch.phases.map(p => p.start_ms + p.duration_ms),
    launch.total_ms ?? 0
  )

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Tile label="Launch time" note="Start to ready" value={formatMs(launch.total_ms)} />
        <Tile
          label="Uptime"
          note={`Since ${clock(daemon.started_at)}`}
          value={formatUptime(daemon.uptime_s)}
        />
        <Tile
          label="CPU"
          note={latest ? `${latest.processes} processes` : 'Measuring'}
          value={latest ? `${Math.round(latest.cpu)}%` : '—'}
        />
        <Tile
          label="Memory"
          note={host.memory_total ? `of ${formatBytes(host.memory_total)}` : undefined}
          value={latest ? formatBytes(latest.rss) : '—'}
        />
        <Tile
          label="Prompt cache hits"
          note={`Last ${prompt?.window_h ?? 24} hours`}
          value={formatPercent(prompt?.hit_rate)}
        />
        <Tile
          label="Database cache hits"
          note={`${number(caches.sqlite.statements)} statements`}
          value={formatPercent(caches.sqlite.cache_hit_rate)}
        />
      </div>

      <Group description="From the daemon starting until it was ready for apps." title="Launch">
        {launch.phases.length ? (
          launch.phases.map(phase => (
            <Row
              control={<Value>{formatMs(phase.duration_ms)}</Value>}
              key={phase.name}
              title={phase.name}
            >
              <div aria-hidden className="relative mt-1.5 h-1.5 rounded-full bg-foreground/[0.06]">
                <div
                  className="absolute inset-y-0 rounded-full"
                  style={{
                    background: 'var(--hex-chart-1)',
                    left: `${(phase.start_ms / span) * 100}%`,
                    minWidth: 3,
                    width: `${(phase.duration_ms / span) * 100}%`
                  }}
                />
              </div>
            </Row>
          ))
        ) : (
          <Row
            description="Only a daemon started with hexbot serve times its launch."
            title="No launch phases"
          />
        )}
      </Group>

      <Group title="Load">
        <Row
          control={<Value>{`${load.running} of ${load.capacity}`}</Value>}
          description={`${load.capacity_free} of ${load.capacity} bot process slots free`}
          title="Running turns"
        />
        <Row
          control={<Value>{load.sessions}</Value>}
          description="Bot processes kept warm"
          title="Open conversations"
        />
        <Row control={<Value>{load.sockets}</Value>} title="Connected apps and browsers" />
        <Row control={<Value>{load.rpc_per_minute}</Value>} title="Requests in the last minute" />
        <Row control={<Value>{load.runs_last_hour}</Value>} title="Runs in the last hour" />
      </Group>

      <Group title="Host">
        <Row control={<Value>{host.hostname ?? '—'}</Value>} title="Name" />
        <Row
          control={<Value>{host.os_version ?? host.os}</Value>}
          description={host.kernel ?? undefined}
          title="System"
        />
        <Row
          control={<Value>{host.cpu_cores ? `${host.cpu_cores} cores` : '—'}</Value>}
          description={[host.cpu_model, host.arch].filter(Boolean).join(' · ')}
          title="Processor"
        />
        <Row
          control={<Value>{formatBytes(host.memory_available)} free</Value>}
          description={`${formatBytes(host.memory_total)} in all`}
          title="Memory"
        />
        <Row
          control={<Value>{formatBytes(host.disk_available)} free</Value>}
          description={`${formatBytes(host.disk_total)} in all, on the disk holding ${daemon.home}`}
          title="Disk"
        />
        <Row
          control={<Value>{host.load ? host.load.map(v => v.toFixed(2)).join('  ') : '—'}</Value>}
          description="Average runnable processes over 1, 5 and 15 minutes"
          title="System load"
        />
      </Group>

      <Group title="Daemon">
        <Row control={<Value>{daemon.version}</Value>} title="Version" />
        <Row control={<Value>{daemon.pi_version ?? '—'}</Value>} title="Pi" />
        <Row control={<Value>{daemon.pid}</Value>} title="Process ID" />
        <Row
          control={
            <Value>{(daemon.supervisor && SUPERVISOR[daemon.supervisor]) ?? 'A terminal'}</Value>
          }
          title="Started by"
        />
        <Row
          control={<Value>{new Date(daemon.started_at).toLocaleString()}</Value>}
          title="Started"
        />
      </Group>

      <Group title="This window">
        <Row control={<Value>{formatMs(timing.firstPaint)}</Value>} title="First paint" />
        <Row
          control={<Value>{formatMs(timing.loaded ?? timing.ready)}</Value>}
          title="Page loaded"
        />
        <Row
          control={<Value>{formatMs(roundTrip)}</Value>}
          description="One ping to the daemon and back"
          title="Round trip"
        />
      </Group>
    </>
  )
}

// ---------------------------------------------------------------- resources

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const element = ref.current

    if (!element) {
      return
    }

    setWidth(element.clientWidth)

    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width))
    observer.observe(element)

    return () => observer.disconnect()
  }, [])

  return [ref, width] as const
}

/** One series over time, with a crosshair and a readout under the pointer. */
export function TimeChart({
  format,
  height = 132,
  label,
  points,
  unit = 1
}: {
  format: (value: number) => string
  height?: number
  label: string
  points: { t: number; v: number }[]
  /** Ticks round in this unit, such as a mebibyte for memory. */
  unit?: number
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<null | number>(null)
  const gradient = useId()
  const left = 64
  const bottom = 20
  const plotWidth = Math.max(0, width - left - 8)
  const plotHeight = height - bottom - 8
  const top = niceMax((Math.max(0, ...points.map(p => p.v)) * 1.1) / unit) * unit
  const first = points[0]?.t ?? 0
  const last = points.at(-1)?.t ?? first + 1
  const range = Math.max(1, last - first)
  const x = (t: number) => left + ((t - first) / range) * plotWidth
  const y = (v: number) => 8 + plotHeight - (v / top) * plotHeight

  const line = points
    .map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`)
    .join('')

  const area = points.length
    ? `${line}L${x(last).toFixed(1)},${y(0)}L${x(first).toFixed(1)},${y(0)}Z`
    : ''

  const peak = points.reduce((max, p) => Math.max(max, p.v), 0)
  const now = points.at(-1)
  const active = hover == null ? null : points[hover]

  const pick = (clientX: number, box: DOMRect) => {
    if (!points.length) {
      return
    }

    const t = first + ((clientX - box.left - left) / Math.max(1, plotWidth)) * range
    const distance = points.map(p => Math.abs(p.t - t))

    setHover(distance.indexOf(Math.min(...distance)))
  }

  return (
    <div className={cn(cardClass, 'px-4 pt-3 pb-2')}>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <p className="text-[length:var(--text-body)] font-medium">{label}</p>
        <p className="text-[length:var(--text-meta)] text-muted tabular-nums">
          {now ? `Now ${format(now.v)} · Peak ${format(peak)}` : 'Measuring'}
        </p>
      </div>
      <div className="relative" ref={ref}>
        {width > 0 ? (
          <svg
            aria-label={`${label}: now ${now ? format(now.v) : 'unknown'}, peak ${format(peak)}`}
            className="block touch-none outline-none"
            height={height}
            onBlur={() => setHover(null)}
            onKeyDown={event => {
              if (!points.length || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) {
                return
              }

              event.preventDefault()
              const step = event.key === 'ArrowLeft' ? -1 : 1
              setHover(current =>
                Math.min(points.length - 1, Math.max(0, (current ?? points.length - 1) + step))
              )
            }}
            onPointerLeave={() => setHover(null)}
            onPointerMove={event =>
              pick(event.clientX, event.currentTarget.getBoundingClientRect())
            }
            role="img"
            tabIndex={0}
            width={width}
          >
            <defs>
              <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="var(--hex-chart-1)" stopOpacity="0.16" />
                <stop offset="1" stopColor="var(--hex-chart-1)" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            {[0, 0.5, 1].map(f => (
              <g key={f}>
                <line
                  stroke="currentColor"
                  strokeOpacity={0.08}
                  x1={left}
                  x2={left + plotWidth}
                  y1={y(top * f)}
                  y2={y(top * f)}
                />
                <text
                  className="fill-current text-muted"
                  dominantBaseline="middle"
                  fontSize={11}
                  textAnchor="end"
                  x={left - 8}
                  y={y(top * f)}
                >
                  {format(top * f)}
                </text>
              </g>
            ))}
            {points.length ? (
              <>
                <text className="fill-current text-muted" fontSize={11} x={left} y={height - 4}>
                  {clock(first)}
                </text>
                <text
                  className="fill-current text-muted"
                  fontSize={11}
                  textAnchor="end"
                  x={left + plotWidth}
                  y={height - 4}
                >
                  {clock(last)}
                </text>
                <path d={area} fill={`url(#${gradient})`} />
                <path
                  d={line}
                  fill="none"
                  stroke="var(--hex-chart-1)"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                />
              </>
            ) : null}
            {active ? (
              <>
                <line
                  stroke="currentColor"
                  strokeOpacity={0.25}
                  x1={x(active.t)}
                  x2={x(active.t)}
                  y1={8}
                  y2={8 + plotHeight}
                />
                <circle
                  cx={x(active.t)}
                  cy={y(active.v)}
                  fill="var(--hex-chart-1)"
                  r={4}
                  stroke="var(--hex-background)"
                  strokeWidth={2}
                />
              </>
            ) : null}
          </svg>
        ) : (
          <div style={{ height }} />
        )}
        {active ? (
          <div
            className="hex-glass pointer-events-none absolute top-1 rounded-[10px] px-2.5 py-1.5 text-[length:var(--text-meta)] whitespace-nowrap"
            role="status"
            style={
              x(active.t) > width / 2
                ? { right: width - x(active.t) + 10 }
                : { left: x(active.t) + 10 }
            }
          >
            <span className="font-semibold tabular-nums">{format(active.v)}</span>
            <span className="ml-2 text-muted">{clock(active.t)}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) {
    return <span className="inline-block h-5 w-16" />
  }

  const top = Math.max(1, ...values)

  const d = values
    .map(
      (v, i) =>
        `${i ? 'L' : 'M'}${((i / (values.length - 1)) * 64).toFixed(1)},${(19 - (v / top) * 18).toFixed(1)}`
    )
    .join('')

  return (
    <svg aria-hidden className="shrink-0" height={20} width={64}>
      <path
        d={d}
        fill="none"
        stroke="var(--hex-chart-1)"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </svg>
  )
}

const MIB = 1024 * 1024

const cpuText = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)}%`

function Resources({ snapshot }: { snapshot: DiagnosticsSnapshot }) {
  const { resources } = snapshot
  const [open, setOpen] = useState<null | number>(null)
  const samples = resources.samples
  const opened = resources.processes.find(p => p.pid === open)

  return (
    <>
      {resources.error ? (
        <p className="text-[length:var(--text-secondary)] text-warning" role="status">
          The process table could not be read: {resources.error}
        </p>
      ) : null}
      <div className="space-y-3">
        <p className="px-1 text-[length:var(--text-meta)] font-medium text-muted">
          The daemon and every process it started, over the last hour
        </p>
        <TimeChart
          format={cpuText}
          label="CPU, percent of one core"
          points={samples.map(s => ({ t: s.t, v: s.cpu }))}
        />
        <TimeChart
          format={formatBytes}
          label="Memory in use"
          points={samples.map(s => ({ t: s.t, v: s.rss }))}
          unit={MIB}
        />
      </div>

      <Group
        description="Live. Select a process for its last ten minutes."
        footer={`Sampled every ${resources.interval_s} seconds.`}
        title="Process tree"
      >
        {resources.processes.length ? (
          resources.processes.map(process => (
            <ProcessRow
              key={process.pid}
              onToggle={() => setOpen(current => (current === process.pid ? null : process.pid))}
              open={open === process.pid}
              process={process}
            />
          ))
        ) : (
          <Row
            description="The first sample arrives within a few seconds."
            title="No processes yet"
          />
        )}
      </Group>

      {opened?.history?.length ? (
        <div className="space-y-3">
          <p className="px-1 text-[length:var(--text-meta)] font-medium text-muted">
            {opened.label ?? opened.name} · {opened.pid}
          </p>
          <TimeChart
            format={cpuText}
            height={110}
            label="CPU"
            points={opened.history.map(([t, cpu]) => ({ t, v: cpu }))}
          />
          <TimeChart
            format={formatBytes}
            height={110}
            label="Memory"
            points={opened.history.map(([t, , rss]) => ({ t, v: rss }))}
            unit={MIB}
          />
        </div>
      ) : null}
    </>
  )
}

function ProcessRow({
  onToggle,
  open,
  process
}: {
  onToggle: () => void
  open: boolean
  process: DiagnosticsProcess
}) {
  return (
    <button
      aria-expanded={open}
      className={cn(
        'flex min-h-[48px] w-full items-center gap-3 px-4 py-2 text-left outline-none transition-colors hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.04]',
        open && 'bg-foreground/[0.04]'
      )}
      onClick={onToggle}
      type="button"
    >
      <div className="min-w-0 flex-1" style={{ paddingLeft: Math.min(process.depth, 6) * 16 }}>
        <div className="truncate text-[length:var(--text-body)]">
          {process.depth ? <span className="mr-1.5 text-muted/60">└</span> : null}
          {process.label ?? process.name}
        </div>
        <div className="truncate text-[length:var(--text-meta)] text-muted">
          {process.label ? `${process.name} · ` : ''}PID {process.pid}
        </div>
      </div>
      <Sparkline values={(process.history ?? []).map(([, cpu]) => cpu)} />
      <span className="w-14 text-right font-mono text-[length:var(--text-secondary)] tabular-nums">
        {cpuText(process.cpu)}
      </span>
      <span className="w-20 text-right font-mono text-[length:var(--text-secondary)] text-muted tabular-nums">
        {formatBytes(process.rss)}
      </span>
    </button>
  )
}

// ------------------------------------------------------------------- traces

function Traces({
  onSpanName,
  onTrace,
  snapshot,
  spanName,
  trace
}: {
  onSpanName: (name: string) => void
  onTrace: (trace: null | number) => void
  snapshot: DiagnosticsSnapshot
  spanName: string
  trace: null | number
}) {
  const bots = useBots(state => state.byName)
  const { spans } = snapshot
  const now = snapshot.generated_at

  const runName = (span: DiagnosticsSpan) => {
    const bot = String(span.attrs.bot ?? '')

    return bots[bot]?.display_name ?? (bot || span.name)
  }

  return (
    <>
      <Group
        description="Each run of a bot, from the first model call to its answer. Select one for its steps."
        title="Recent runs"
      >
        {spans.traces.length ? (
          spans.traces.map(run => (
            <div key={run.id}>
              <button
                aria-expanded={trace === run.trace}
                className="flex min-h-[52px] w-full items-center gap-3 px-4 py-2.5 text-left outline-none transition-colors hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.04]"
                onClick={() => onTrace(trace === run.trace ? null : run.trace)}
                type="button"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[length:var(--text-body)]">{runName(run)}</div>
                  <div className="truncate text-[length:var(--text-secondary)] text-muted">
                    {ago(run.start, now)} · {String(run.attrs.model_calls ?? 0)} model calls ·{' '}
                    {String(run.attrs.tool_calls ?? 0)} tools · cache{' '}
                    {formatPercent(run.attrs.cache_hit_rate as null | number)}
                  </div>
                </div>
                {run.errors ? <Chip tone="danger">{run.errors} failed</Chip> : null}
                <Value>{formatMs(run.duration_ms)}</Value>
                <ChevronDown
                  className={cn(
                    'shrink-0 text-muted transition-transform',
                    trace === run.trace && 'rotate-180'
                  )}
                  size={15}
                />
              </button>
              {trace === run.trace ? <Waterfall trace={run.trace} /> : null}
            </div>
          ))
        ) : (
          <Row description="Runs appear here once a bot answers." title="No runs yet" />
        )}
      </Group>

      <SpanNames onSpanName={onSpanName} snapshot={snapshot} spanName={spanName} />

      <Group
        action={
          <div className="w-56">
            <Select
              label="Span name"
              onValueChange={value => onSpanName(value === '__all__' ? '' : value)}
              options={[
                { label: 'All spans', value: '__all__' },
                ...spans.names.map(name => ({ label: name.name, value: name.name }))
              ]}
              value={spanName || '__all__'}
            />
          </div>
        }
        description="The latest 200 spans, newest first."
        title="Span log"
      >
        {spans.recent.length ? (
          spans.recent.map(span => (
            <Row
              control={<Value>{formatMs(span.duration_ms)}</Value>}
              description={
                span.error ? (
                  <span className="line-clamp-2 text-danger">{span.error}</span>
                ) : (
                  `${clock(span.start)} · ${KIND_LABEL[span.kind]}`
                )
              }
              key={span.id}
              title={
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: KIND_COLOR[span.kind] }}
                  />
                  <span className="truncate font-mono text-[length:var(--text-secondary)]">
                    {span.name}
                  </span>
                </span>
              }
            />
          ))
        ) : (
          <Row title="No spans" />
        )}
      </Group>
    </>
  )
}

function SpanNames({
  onSpanName,
  snapshot,
  spanName
}: {
  onSpanName: (name: string) => void
  snapshot: DiagnosticsSnapshot
  spanName: string
}) {
  const { spans } = snapshot
  const head = 'px-2 py-2 text-right font-medium'

  return (
    <Group
      description={`Over the latest ${number(spans.kept)} spans. Select a name to filter the span log.`}
      title="Span names"
    >
      <div className="overflow-x-auto">
        <table className="w-full table-fixed text-[length:var(--text-secondary)] tabular-nums">
          <colgroup>
            <col />
            <col className="w-16" />
            <col className="w-16" />
            <col className="w-20" />
            <col className="w-20" />
            <col className="w-24" />
          </colgroup>
          <thead className="text-[length:var(--text-meta)] text-muted">
            <tr className="border-b border-foreground/[0.07]">
              <th className="py-2 pr-2 pl-4 text-left font-medium">Name</th>
              <th className={head}>Count</th>
              <th className={head}>Failed</th>
              <th className={head}>Average</th>
              <th className={head}>p95</th>
              <th className={cn(head, 'pr-4')}>Max</th>
            </tr>
          </thead>
          <tbody className={dividerClass}>
            {spans.names.slice(0, 40).map(name => (
              <tr
                aria-selected={spanName === name.name}
                className={cn(
                  'cursor-pointer transition-colors hover:bg-foreground/[0.03]',
                  spanName === name.name && 'bg-foreground/[0.05]'
                )}
                key={name.name}
                onClick={() => onSpanName(spanName === name.name ? '' : name.name)}
              >
                <td className="max-w-0 py-2 pr-2 pl-4">
                  <button
                    className="flex w-full min-w-0 items-center gap-2 text-left outline-none hex-focus"
                    onClick={event => {
                      event.stopPropagation()
                      onSpanName(spanName === name.name ? '' : name.name)
                    }}
                    type="button"
                  >
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: KIND_COLOR[name.kind] }}
                    />
                    <span className="truncate font-mono" title={name.name}>
                      {name.name}
                    </span>
                  </button>
                </td>
                <td className="px-2 py-2 text-right">{number(name.count)}</td>
                <td
                  className={cn('px-2 py-2 text-right', name.errors ? 'text-danger' : 'text-muted')}
                >
                  {number(name.errors)}
                </td>
                <td className="px-2 py-2 text-right">{formatMs(name.avg_ms)}</td>
                <td className="px-2 py-2 text-right">{formatMs(name.p95_ms)}</td>
                <td className="py-2 pr-4 pl-2 text-right">{formatMs(name.max_ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <KindLegend />
    </Group>
  )
}

function KindLegend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-2.5 text-[length:var(--text-meta)] text-muted">
      {(Object.keys(KIND_LABEL) as DiagnosticsSpan['kind'][]).map(kind => (
        <span className="inline-flex items-center gap-1.5" key={kind}>
          <span
            aria-hidden
            className="size-2 rounded-full"
            style={{ background: KIND_COLOR[kind] }}
          />
          {KIND_LABEL[kind]}
        </span>
      ))}
    </div>
  )
}

const ATTR_LABEL: Record<string, string> = {
  cache_hit_rate: 'Cache hits',
  cache_read: 'Cached input',
  cache_write: 'Written to cache',
  code: 'Error code',
  cost: 'Cost',
  first_token_ms: 'First token',
  input: 'Input tokens',
  model: 'Model',
  model_calls: 'Model calls',
  output: 'Output tokens',
  provider: 'Provider',
  section: 'Conversation',
  stop_reason: 'Stop reason',
  tool: 'Tool',
  tool_calls: 'Tool calls'
}

function attrText(key: string, value: unknown): string {
  if (value == null || value === '') {
    return '—'
  }

  if (key === 'cache_hit_rate') {
    return formatPercent(value as number)
  }

  if (key === 'first_token_ms') {
    return formatMs(value as number)
  }

  if (key === 'cost') {
    return `$${(value as number).toFixed(4)}`
  }

  return typeof value === 'number' ? number(value) : String(value)
}

/** The spans of one run on a shared time axis. */
function Waterfall({ trace }: { trace: number }) {
  const [spans, setSpans] = useState<DiagnosticsSpan[] | null>(null)
  const [error, setError] = useState<null | string>(null)
  const [selected, setSelected] = useState<null | number>(null)

  useEffect(() => {
    let alive = true

    diagnosticsTrace(trace).then(
      result => alive && setSpans(result.spans),
      caught => alive && setError(errorText(caught))
    )

    return () => {
      alive = false
    }
  }, [trace])

  if (error) {
    return <p className="px-4 pb-3 text-[length:var(--text-secondary)] text-danger">{error}</p>
  }

  if (!spans) {
    return <SkeletonLines className="px-4 pb-3" label="Loading the run" lines={3} />
  }

  const root = spans[0]

  if (!root) {
    return (
      <p className="px-4 pb-3 text-[length:var(--text-secondary)] text-muted">
        This run is older than the spans the daemon keeps.
      </p>
    )
  }

  const begin = Math.min(...spans.map(s => s.start))
  const end = Math.max(...spans.map(s => s.start + s.duration_ms))
  const total = Math.max(1, end - begin)
  const detail = spans.find(s => s.id === selected) ?? null

  return (
    <div className="border-t border-foreground/[0.07] bg-foreground/[0.015] px-4 py-3">
      <ul aria-label="Steps of this run" className="space-y-1">
        {spans.map(span => (
          <li key={span.id}>
            <button
              aria-pressed={selected === span.id}
              className={cn(
                'grid w-full grid-cols-[minmax(0,180px)_1fr_64px] items-center gap-3 rounded-[8px] px-1.5 py-1 text-left outline-none transition-colors hover:bg-foreground/[0.04] hex-focus',
                selected === span.id && 'bg-foreground/[0.06]'
              )}
              onClick={() => setSelected(current => (current === span.id ? null : span.id))}
              type="button"
            >
              <span
                className={cn(
                  'truncate font-mono text-[length:var(--text-meta)]',
                  span.parent != null && 'pl-3',
                  span.error && 'text-danger'
                )}
              >
                {span.name}
              </span>
              <span className="relative h-3">
                <span
                  className="absolute inset-y-0 rounded-[4px]"
                  style={{
                    background: span.error ? 'var(--color-danger)' : KIND_COLOR[span.kind],
                    left: `${((span.start - begin) / total) * 100}%`,
                    minWidth: 3,
                    width: `${(span.duration_ms / total) * 100}%`
                  }}
                />
              </span>
              <span className="text-right font-mono text-[length:var(--text-meta)] text-muted tabular-nums">
                {formatMs(span.duration_ms)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <KindLegendInline />
        <span className="text-[length:var(--text-meta)] text-muted">Red marks a failed step</span>
      </div>
      {detail ? (
        <dl className="mt-3 grid grid-cols-[140px_1fr] gap-x-3 gap-y-1 rounded-[10px] bg-foreground/[0.03] px-3 py-2.5 text-[length:var(--text-meta)]">
          <dt className="text-muted">Started</dt>
          <dd className="tabular-nums">{clock(detail.start)}</dd>
          <dt className="text-muted">Took</dt>
          <dd className="tabular-nums">{formatMs(detail.duration_ms)}</dd>
          {Object.entries(detail.attrs)
            .filter(([key, value]) => key in ATTR_LABEL && value != null && value !== '')
            .map(([key, value]) => (
              <div className="contents" key={key}>
                <dt className="text-muted">{ATTR_LABEL[key]}</dt>
                <dd className="truncate tabular-nums">{attrText(key, value)}</dd>
              </div>
            ))}
          {detail.error ? (
            <>
              <dt className="text-muted">Error</dt>
              <dd className="text-danger [overflow-wrap:anywhere]">{detail.error}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </div>
  )
}

function KindLegendInline() {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[length:var(--text-meta)] text-muted">
      {(['run', 'model', 'tool'] as const).map(kind => (
        <span className="inline-flex items-center gap-1.5" key={kind}>
          <span
            aria-hidden
            className="h-2 w-3 rounded-[2px]"
            style={{ background: KIND_COLOR[kind] }}
          />
          {KIND_LABEL[kind]}
        </span>
      ))}
    </div>
  )
}

// ----------------------------------------------------------------- failures

function Failures({
  onTrace,
  snapshot
}: {
  onTrace: (trace: number) => void
  snapshot: DiagnosticsSnapshot
}) {
  const { failures } = snapshot
  const now = snapshot.generated_at

  if (!failures.total) {
    return (
      <Group title="Failures">
        <Row
          description="Failed runs, requests and bot processes appear here. Failed tool steps stay in their run."
          title="Nothing has failed since the daemon started"
        />
      </Group>
    )
  }

  return (
    <>
      <Group
        description="Repeats of one problem count together, whatever their numbers and ids."
        title="Most common"
      >
        {failures.common.map(group => (
          <Row
            control={<Chip tone="danger">{number(group.count)}×</Chip>}
            description={`${FAILURE_KIND[group.kind] ?? group.kind} · ${group.source} · last ${ago(group.last, now)}`}
            key={`${group.kind}-${group.source}-${group.pattern}`}
            title={<span className="line-clamp-2 [overflow-wrap:anywhere]">{group.example}</span>}
          />
        ))}
      </Group>

      <Group
        description={`${number(failures.total)} since the daemon started.`}
        title="Last failures"
      >
        {failures.recent.map((failure, index) => (
          <Row
            control={
              failure.trace != null && failure.kind !== 'rpc' ? (
                <Button onClick={() => onTrace(failure.trace as number)} size="sm" variant="ghost">
                  Show run
                </Button>
              ) : undefined
            }
            description={`${clock(failure.at)} · ${FAILURE_KIND[failure.kind] ?? failure.kind} · ${failure.source}`}
            key={`${failure.at}-${index}`}
            title={<span className="line-clamp-3 [overflow-wrap:anywhere]">{failure.message}</span>}
          />
        ))}
      </Group>
    </>
  )
}

// ------------------------------------------------------------------- caches

function Meter({ ratio }: { ratio: null | number }) {
  return (
    <span
      aria-hidden
      className="relative block h-1.5 w-24 overflow-hidden rounded-full bg-foreground/[0.07]"
    >
      <span
        className="absolute inset-y-0 left-0 rounded-full"
        style={{ background: 'var(--hex-chart-1)', width: `${Math.round((ratio ?? 0) * 100)}%` }}
      />
    </span>
  )
}

function CacheRows({
  label,
  name,
  rows
}: {
  label: string
  name: (row: DiagnosticsCacheRow) => string
  rows: DiagnosticsCacheRow[]
}) {
  if (!rows.length) {
    return null
  }

  return (
    <Group title={label}>
      {rows.map(row => (
        <Row
          control={
            <>
              <Meter ratio={row.hit_rate} />
              <span className="w-14 text-right font-mono text-[length:var(--text-secondary)] tabular-nums">
                {formatPercent(row.hit_rate)}
              </span>
            </>
          }
          description={`${number(row.calls)} calls · ${number(row.cache_read)} of ${number(row.input + row.cache_read + row.cache_write)} input tokens from cache`}
          key={row.name}
          title={name(row) || 'Unknown'}
        />
      ))}
    </Group>
  )
}

function StatementRows({ rows, title }: { rows: DiagnosticsStatement[]; title: string }) {
  if (!rows.length) {
    return null
  }

  return (
    <Group title={title}>
      {rows.map(row => (
        <Row
          control={
            <Value>{formatMs(title === 'Slowest statements' ? row.max_ms : row.total_ms)}</Value>
          }
          description={`${number(row.count)} ${row.count === 1 ? 'run' : 'runs'} · ${formatMs(row.avg_ms)} on average`}
          key={row.sql}
          title={
            <code className="line-clamp-2 font-mono text-[length:var(--text-meta)] [overflow-wrap:anywhere]">
              {row.sql}
            </code>
          }
        />
      ))}
    </Group>
  )
}

function Caches({ snapshot }: { snapshot: DiagnosticsSnapshot }) {
  const bots = useBots(state => state.byName)
  const { prompt, sqlite } = snapshot.caches

  return (
    <>
      {'error' in prompt ? (
        <Group title="Prompt cache">
          <Row description={prompt.error} title="Prompt cache use is unavailable" />
        </Group>
      ) : (
        <>
          <Group
            description={`Input tokens the provider read from its cache in the last ${prompt.window_h} hours. Higher is cheaper and faster.`}
            title="Prompt cache"
          >
            <Row
              control={
                <>
                  <Meter ratio={prompt.hit_rate} />
                  <span className="w-14 text-right font-mono text-[length:var(--text-secondary)] tabular-nums">
                    {formatPercent(prompt.hit_rate)}
                  </span>
                </>
              }
              description={`${number(prompt.calls)} model calls`}
              title="Hit rate"
            />
            <Row control={<Value>{number(prompt.cache_read)}</Value>} title="Read from cache" />
            <Row control={<Value>{number(prompt.cache_write)}</Value>} title="Written to cache" />
            <Row control={<Value>{number(prompt.input)}</Value>} title="Not cached" />
          </Group>
          <CacheRows
            label="By bot"
            name={row => bots[row.name]?.display_name ?? row.name}
            rows={prompt.by_bot}
          />
          <CacheRows label="By model" name={row => row.name} rows={prompt.by_model} />
        </>
      )}

      <Group
        description="SQLite on this computer. Each connection keeps its own page cache; a miss reads the file."
        title="Local database"
      >
        <Row
          control={
            <>
              <Meter ratio={sqlite.cache_hit_rate} />
              <span className="w-14 text-right font-mono text-[length:var(--text-secondary)] tabular-nums">
                {formatPercent(sqlite.cache_hit_rate)}
              </span>
            </>
          }
          description={`${number(sqlite.cache_hits)} pages from memory, ${number(sqlite.cache_misses)} read from the file`}
          title="Page cache hit rate"
        />
        <Row
          control={<Value>{number(sqlite.opens)}</Value>}
          description={`${formatMs(sqlite.open_avg_ms)} on average, ${formatMs(sqlite.open_max_ms)} at most`}
          title="Connections opened"
        />
        <Row
          control={<Value>{number(sqlite.statements)}</Value>}
          description={`${formatMs(sqlite.statement_avg_ms)} on average, ${formatMs(sqlite.statement_total_ms)} in all`}
          title="Statements run"
        />
        <Row control={<Value>{formatBytes(sqlite.db_bytes)}</Value>} title="Database file" />
        <Row
          control={<Value>{formatBytes(sqlite.runtime_db_bytes)}</Value>}
          description="Conversations and token use"
          title="Conversation store"
        />
        <Row
          control={<Value>{formatBytes(sqlite.wal_bytes)}</Value>}
          description="Changes not yet folded into the database file"
          title="Write-ahead log"
        />
      </Group>
      <StatementRows rows={sqlite.slowest} title="Slowest statements" />
      <StatementRows rows={sqlite.busiest} title="Most time in all" />
    </>
  )
}
