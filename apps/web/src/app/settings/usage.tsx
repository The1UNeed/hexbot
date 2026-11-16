import { Check } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Select } from '../../components/ui/select'
import { SkeletonLines } from '../../components/ui/skeleton'
import { usageReport, usageSummary } from '../../lib/api'
import { cn } from '../../lib/cn'
import type { UsagePlace, UsageReport, UsageSummary } from '../../lib/types'
import {
  bucketLabel,
  colorSlots,
  columnPath,
  costComparison,
  earlierNote,
  filterRows,
  formatCost,
  formatCostTick,
  formatShare,
  formatTokens,
  groupsOf,
  modelKey,
  modelName,
  modelNames,
  modelParts,
  niceTop,
  OTHER,
  PLACE_LABELS,
  seriesOf,
  totalsOf,
  USAGE_RANGES,
  type UsageDimension,
  type UsageGroup,
  type UsageMetric,
  type UsageRange,
  type UsageSeries,
  type UsageTotals,
  usageWindow,
  type UsageWindow
} from '../../lib/usage-report'
import { useBots } from '../../stores/bots'
import { unknownMethod } from '../../stores/me'
import { useSettings } from '../../stores/settings'
import { cardClass, dividerClass, errorText, Group, Heading, Row } from '../bot-settings/shared'

const ALL = '\u0000all'

const SPLITS: [UsageDimension, string][] = [
  ['bot', 'Bots'],
  ['model', 'Models'],
  ['place', 'Where']
]

const METRICS: [UsageMetric, string][] = [
  ['cost', 'Cost'],
  ['tokens', 'Tokens']
]

const OTHER_LABEL: Record<UsageDimension, string> = {
  bot: 'Other bots',
  model: 'Other models',
  place: 'Other places'
}

const slotColor = (slot: number | undefined) =>
  slot == null ? 'var(--hex-muted-text)' : `var(--hex-chart-${slot + 1})`

const slotOpacity = (slot: number | undefined) => (slot == null ? 0.45 : 1)

/** A few choices in a row, like Diagnostics' views. */
function Pills<Key extends string>({
  label,
  onChange,
  options,
  size = 'md',
  value
}: {
  label: string
  onChange: (key: Key) => void
  options: [Key, string][]
  size?: 'md' | 'sm'
  value: Key
}) {
  return (
    <div aria-label={label} className="flex flex-wrap gap-1" role="tablist">
      {options.map(([key, text]) => (
        <button
          aria-selected={value === key}
          className={cn(
            'rounded-full transition-colors hex-focus',
            size === 'sm'
              ? 'h-6 px-2.5 text-[length:var(--text-meta)]'
              : 'h-7 px-3 text-[length:var(--text-secondary)]',
            value === key
              ? 'bg-foreground text-background'
              : 'text-muted hover:bg-foreground/[0.06] hover:text-foreground'
          )}
          key={key}
          onClick={() => onChange(key)}
          role="tab"
          type="button"
        >
          {text}
        </button>
      ))}
    </div>
  )
}

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

/** Columns over time, each split into the top series and Other. */
function StackedColumns({
  format,
  name,
  series,
  slots,
  tick
}: {
  format: (value: number) => string
  name: (key: string) => string
  series: UsageSeries
  slots: Map<string, number>
  tick: (value: number) => string
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<null | number>(null)
  const height = 184
  const left = 52
  const bottom = 22
  const top = 8
  const { buckets, keys } = series
  const plotWidth = Math.max(0, width - left - 4)
  const plotHeight = height - bottom - top
  const peak = niceTop(Math.max(0, ...buckets.map(b => b.total)))
  const band = buckets.length ? plotWidth / buckets.length : 0
  const barWidth = Math.max(1, Math.min(24, band * 0.68))
  const y = (value: number) => top + plotHeight - (value / peak) * plotHeight
  const active = hover == null ? null : buckets[hover]
  const xOf = (index: number) => left + band * index + (band - barWidth) / 2

  const labelled =
    buckets.length > 2
      ? [0, Math.floor((buckets.length - 1) / 2), buckets.length - 1]
      : buckets.map((_, i) => i)

  return (
    <div className="relative" ref={ref}>
      {width > 0 ? (
        <svg
          aria-label={`${buckets.length} columns, highest ${format(Math.max(0, ...buckets.map(b => b.total)))}. Use the arrow keys to read each.`}
          className="block touch-pan-y outline-none"
          height={height}
          onBlur={() => setHover(null)}
          onKeyDown={event => {
            if (!buckets.length || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) {
              return
            }

            event.preventDefault()
            const step = event.key === 'ArrowLeft' ? -1 : 1
            setHover(current =>
              Math.min(buckets.length - 1, Math.max(0, (current ?? buckets.length - 1) + step))
            )
          }}
          onPointerLeave={() => setHover(null)}
          onPointerMove={event => {
            const box = event.currentTarget.getBoundingClientRect()
            const index = Math.floor((event.clientX - box.left - left) / Math.max(1, band))
            setHover(index >= 0 && index < buckets.length ? index : null)
          }}
          role="img"
          tabIndex={0}
          width={width}
        >
          {[0, 0.5, 1].map(f => (
            <g key={f}>
              <line
                stroke="currentColor"
                strokeOpacity={0.08}
                x1={left}
                x2={left + plotWidth}
                y1={y(peak * f)}
                y2={y(peak * f)}
              />
              <text
                className="fill-current text-muted tabular-nums"
                dominantBaseline="middle"
                fontSize={11}
                textAnchor="end"
                x={left - 8}
                y={y(peak * f)}
              >
                {tick(peak * f)}
              </text>
            </g>
          ))}
          {buckets.map((bucket, index) => {
            let base = bucket.total
            const drawn = keys.filter(key => (bucket.values[key] ?? 0) > 0)

            return (
              <g key={bucket.t} opacity={active && active !== bucket ? 0.45 : 1}>
                {drawn.map((key, at) => {
                  const value = bucket.values[key] ?? 0
                  const yTop = y(base)
                  const fullHeight = y(base - value) - yTop
                  base -= value
                  // A 2px gap between segments; the lowest one sits on the baseline.
                  const h = at === drawn.length - 1 ? fullHeight : Math.max(0, fullHeight - 2)
                  const slot = key === OTHER ? undefined : slots.get(key)

                  if (h <= 0) {
                    return null
                  }

                  return (
                    <path
                      d={columnPath(xOf(index), yTop, barWidth, h, at === 0 ? 4 : 0)}
                      fill={slotColor(slot)}
                      fillOpacity={slotOpacity(slot)}
                      key={key}
                    />
                  )
                })}
              </g>
            )
          })}
          {labelled.map(index => (
            <text
              className="fill-current text-muted"
              fontSize={11}
              key={index}
              textAnchor={index === 0 ? 'start' : index === buckets.length - 1 ? 'end' : 'middle'}
              x={
                index === 0
                  ? left
                  : index === buckets.length - 1
                    ? left + plotWidth
                    : xOf(index) + barWidth / 2
              }
              y={height - 4}
            >
              {bucketLabel(buckets[index]!)}
            </text>
          ))}
        </svg>
      ) : (
        <div style={{ height }} />
      )}
      {active && hover != null ? (
        <div
          className="hex-glass pointer-events-none absolute top-1 z-10 min-w-40 rounded-[10px] px-3 py-2 text-[length:var(--text-meta)]"
          role="status"
          style={
            xOf(hover) > width / 2
              ? { right: width - xOf(hover) + 8 }
              : { left: xOf(hover) + barWidth + 8 }
          }
        >
          <p className="mb-1 text-muted">{bucketLabel(active)}</p>
          {keys
            .filter(key => (active.values[key] ?? 0) > 0)
            .map(key => {
              const slot = key === OTHER ? undefined : slots.get(key)

              return (
                <p className="flex items-center gap-2 whitespace-nowrap" key={key}>
                  <span
                    aria-hidden
                    className="h-0.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: slotColor(slot), opacity: slotOpacity(slot) }}
                  />
                  <span className="font-semibold tabular-nums">
                    {format(active.values[key] ?? 0)}
                  </span>
                  <span className="truncate text-muted">{name(key)}</span>
                </p>
              )
            })}
          <p className="mt-1 flex gap-2 border-t border-foreground/[0.08] pt-1">
            <span className="font-semibold tabular-nums">{format(active.total)}</span>
            <span className="text-muted">Total</span>
          </p>
        </div>
      ) : null}
    </div>
  )
}

function Legend({
  keys,
  name,
  slots
}: {
  keys: string[]
  name: (key: string) => string
  slots: Map<string, number>
}) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[length:var(--text-meta)] text-muted">
      {keys.map(key => {
        const slot = key === OTHER ? undefined : slots.get(key)

        return (
          <li className="flex min-w-0 items-center gap-1.5" key={key}>
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-[2px]"
              style={{ background: slotColor(slot), opacity: slotOpacity(slot) }}
            />
            <span className="max-w-[180px] truncate">{name(key)}</span>
          </li>
        )
      })}
    </ul>
  )
}

const TOKEN_PARTS: { key: keyof UsageTotals; label: string; opacity: number }[] = [
  { key: 'input', label: 'Not cached', opacity: 1 },
  { key: 'cacheRead', label: 'Read from cache', opacity: 0.55 },
  { key: 'cacheWrite', label: 'Written to cache', opacity: 0.3 },
  { key: 'output', label: 'Output', opacity: 0.8 }
]

/** Every token split by kind, as one thin bar with a legend that carries the numbers. */
function TokenMix({ totals }: { totals: UsageTotals }) {
  const parts = TOKEN_PARTS.map(part => ({ ...part, value: totals[part.key] as number }))
  const whole = totals.tokens

  return (
    <Group
      description="Input the provider reads from its cache costs a fraction of new input."
      title="Tokens by kind"
    >
      <div className="px-4 py-3.5">
        <div
          aria-label={parts
            .map(
              part =>
                `${part.label} ${formatTokens(part.value)}, ${formatShare(whole ? part.value / whole : 0)}`
            )
            .join('; ')}
          className="flex h-2 gap-0.5"
          role="img"
        >
          {parts
            .filter(part => part.value > 0)
            .map(part => (
              <span
                className="h-full min-w-0.5 rounded-full first:rounded-l-full last:rounded-r-full"
                key={part.key}
                style={{
                  background: part.key === 'output' ? 'var(--hex-chart-2)' : 'var(--hex-chart-1)',
                  flexGrow: part.value,
                  opacity: part.opacity
                }}
                title={`${part.label}: ${formatTokens(part.value)}`}
              />
            ))}
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 @min-[520px]:grid-cols-4">
          {parts.map(part => (
            <div className="min-w-0" key={part.key}>
              <dt className="flex items-center gap-1.5 text-[length:var(--text-meta)] text-muted">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-[2px]"
                  style={{
                    background: part.key === 'output' ? 'var(--hex-chart-2)' : 'var(--hex-chart-1)',
                    opacity: part.opacity
                  }}
                />
                {part.label}
              </dt>
              <dd className="mt-0.5 text-[length:var(--text-secondary)]">
                <span className="font-medium">{formatTokens(part.value)}</span>{' '}
                <span className="text-muted">{formatShare(whole ? part.value / whole : 0)}</span>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </Group>
  )
}

/** The daemon before `hexbot.usage.report`: totals and bots only. */
function SummaryOnly({ summary }: { summary: UsageSummary }) {
  const bots = useBots(state => state.byName)

  const rows = Array.isArray(summary.by_bot)
    ? summary.by_bot
    : Object.entries(summary.by_bot).map(([bot, value]) => ({ bot, ...value }))

  const value = (text: string) => (
    <span className="font-mono text-[length:var(--text-secondary)] tabular-nums">{text}</span>
  )

  return (
    <div className="space-y-8">
      <p className="text-[length:var(--text-secondary)] text-muted" role="status">
        Update this daemon to see usage over time, by model, and where it went.
      </p>
      <Group title="This daemon">
        <Row control={value(summary.input_tokens.toLocaleString())} title="Input tokens" />
        <Row control={value(summary.output_tokens.toLocaleString())} title="Output tokens" />
        <Row control={value(formatCost(summary.estimated_cost_usd))} title="Estimated cost" />
      </Group>
      {rows.length ? (
        <Group title="By bot">
          {rows.map(row => (
            <Row
              control={value(formatCost(row.estimated_cost_usd ?? 0))}
              description={`${row.input_tokens.toLocaleString()} in · ${row.output_tokens.toLocaleString()} out`}
              key={row.bot}
              title={bots[row.bot]?.display_name ?? row.bot}
            />
          ))}
        </Group>
      ) : null}
    </div>
  )
}

export function UsageSettings() {
  const bots = useBots(state => state.byName)
  const providers = useSettings(state => state.providers)
  const refreshProviders = useSettings(state => state.refreshProviders)

  useEffect(() => {
    // Provider names for models; their ids stand in until they load.
    if (!useSettings.getState().providers.length) {
      void refreshProviders().catch(() => undefined)
    }
  }, [refreshProviders])

  const providerName = (id: string) => providers.find(provider => provider.id === id)?.label || id
  const [range, setRange] = useState<UsageRange>('month')

  // The report with the range and window it was asked for, so its labels stay right when a newer request fails.
  const [loaded, setLoaded] = useState<null | {
    range: UsageRange
    report: UsageReport
    window: UsageWindow
  }>(null)

  const [summary, setSummary] = useState<null | UsageSummary>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [bot, setBot] = useState<null | string>(null)
  const [model, setModel] = useState<null | string>(null)
  const [split, setSplit] = useState<UsageDimension>('bot')
  const [metric, setMetric] = useState<UsageMetric>('cost')

  useEffect(() => {
    let current = true
    setLoading(true)

    const window = usageWindow(range)

    usageReport(window.edges)
      .then(report => {
        if (current) {
          setLoaded({ range, report, window })
          setError(null)
        }
      })
      .catch(async (failure: unknown) => {
        if (!current) {
          return
        }

        if (!unknownMethod(failure)) {
          setError(failure)

          return
        }

        // A daemon from before the report: its totals instead.
        try {
          const older = await usageSummary()

          if (current) {
            setSummary(older)
          }
        } catch (failed) {
          if (current) {
            setError(failed)
          }
        }
      })
      .finally(() => current && setLoading(false))

    return () => {
      current = false
    }
  }, [range])

  const report = loaded?.report ?? null

  const view = useMemo(() => {
    if (!loaded) {
      return null
    }

    const { report, window } = loaded

    const rows = filterRows(report.rows, { bot, model })
    const totals = totalsOf(rows)
    const series = seriesOf(window, rows, split, metric)
    const everyKey = groupsOf(report.rows, split, metric).map(group => group.key)

    const slots = colorSlots(
      everyKey,
      series.keys.filter(key => key !== OTHER)
    )

    const groups = groupsOf(rows, split, metric)

    // A bot's most used model, or a model's busiest bot, under each row.
    const topOf = (group: UsageGroup) => {
      if (split === 'place') {
        return null
      }

      const [first] = groupsOf(
        rows.filter(row => (split === 'bot' ? row.bot : modelKey(row)) === group.key),
        split === 'bot' ? 'model' : 'bot',
        metric
      )

      return first ? first.key : null
    }

    return { groups, rows, series, slots, topOf, totals }
  }, [bot, loaded, metric, model, split])

  // The chart's models, named apart when two providers serve one of the same name.
  const shownModels = modelNames(
    split === 'model' && view ? view.series.keys.filter(key => key !== OTHER) : [],
    providerName
  )

  const name = (dimension: UsageDimension) => (key: string) => {
    if (key === OTHER) {
      return OTHER_LABEL[dimension]
    }

    if (dimension === 'bot') {
      return bots[key]?.display_name || key
    }

    return dimension === 'model'
      ? (shownModels.get(key) ?? modelName(key))
      : (PLACE_LABELS[key as UsagePlace] ?? key)
  }

  const filterBy = (dimension: UsageDimension, key: null | string) => {
    if (dimension === 'bot') {
      setBot(key)

      if (key && split === 'bot') {
        setSplit('model')
      }
    } else if (dimension === 'model') {
      setModel(key)

      if (key && split === 'model') {
        setSplit('bot')
      }
    }
  }

  if (summary) {
    return (
      <>
        <Heading description="Token use reported by this daemon.">Usage</Heading>
        <SummaryOnly summary={summary} />
      </>
    )
  }

  const choices = (dimension: 'bot' | 'model') => {
    const keys = report ? groupsOf(report.rows, dimension).map(group => group.key) : []
    const chosen = dimension === 'bot' ? bot : model

    // A bot or model chosen in another range stays listed, though it has no use in this one.
    if (chosen && !keys.includes(chosen)) {
      keys.push(chosen)
    }

    return keys.map(key => ({
      label:
        dimension === 'model' && modelParts(key).provider
          ? `${modelName(key)} · ${providerName(modelParts(key).provider)}`
          : name(dimension)(key),
      value: key
    }))
  }

  const format = metric === 'cost' ? formatCost : formatTokens
  const tick = metric === 'cost' ? formatCostTick : formatTokens
  const filtered = Boolean(bot || model)
  const grain = view?.series.buckets[0]?.grain ?? 'day'
  const every = grain === 'hour' ? 'Hourly' : grain === 'week' ? 'Weekly' : 'Daily'
  const shown = loaded?.range ?? range

  const comparison =
    view && !filtered ? costComparison(view.totals.cost, report?.previous.cost, shown) : null

  const earlier = filtered ? null : earlierNote(report?.earlier, shown)

  const rangeLabel = USAGE_RANGES.find(r => r.key === shown)!.label

  return (
    <>
      <Heading description="Tokens and estimated cost reported by this daemon, by bot, model, and kind of work.">
        Usage
      </Heading>
      <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3">
        <Pills
          label="Time range"
          onChange={setRange}
          options={USAGE_RANGES.map(r => [r.key, r.label])}
          value={range}
        />
        {report ? (
          <div className="flex w-full gap-2">
            <div className="min-w-0 flex-1">
              <Select
                label="Bot"
                onValueChange={value => filterBy('bot', value === ALL ? null : value)}
                options={[{ label: 'All bots', value: ALL }, ...choices('bot')]}
                value={bot ?? ALL}
              />
            </div>
            <div className="min-w-0 flex-1">
              <Select
                label="Model"
                onValueChange={value => filterBy('model', value === ALL ? null : value)}
                options={[{ label: 'All models', value: ALL }, ...choices('model')]}
                value={model ?? ALL}
              />
            </div>
          </div>
        ) : null}
      </div>
      {error && !report ? (
        <p className="text-[length:var(--text-secondary)] text-danger" role="alert">
          Usage is unavailable: {errorText(error)}
        </p>
      ) : !view ? (
        <SkeletonLines label="Loading usage" lines={6} />
      ) : (
        <div
          aria-busy={loading}
          className={cn('@container space-y-8 transition-opacity', loading && 'opacity-60')}
        >
          {error ? (
            <p
              className="rounded-[12px] bg-warning/10 px-4 py-3 text-[length:var(--text-secondary)] text-warning"
              role="status"
            >
              Showing the last report. {errorText(error)}
            </p>
          ) : null}
          <div>
            <p className="text-[48px] leading-none font-semibold tracking-[-0.02em]">
              {formatCost(view.totals.cost)}
            </p>
            <p className="mt-2 text-[length:var(--text-secondary)] text-muted">
              Estimated cost{filtered ? ' for this selection' : ''},{' '}
              {shown === 'all' ? 'all time' : `last ${rangeLabel}`}
              {comparison ? `, ${comparison}` : ''}
            </p>
            {earlier ? (
              <p className="mt-1 text-[length:var(--text-secondary)] text-muted">{earlier}</p>
            ) : null}
          </div>
          <div className="grid grid-cols-1 gap-3 @min-[480px]:grid-cols-3">
            <Tile
              label="Tokens"
              note={`${formatTokens(view.totals.output)} output`}
              value={formatTokens(view.totals.tokens)}
            />
            <Tile
              label="Cache hit rate"
              note={`${formatTokens(view.totals.cacheRead)} read from cache`}
              value={
                view.totals.hitRate == null ? '—' : `${Math.round(view.totals.hitRate * 100)}%`
              }
            />
            <Tile
              label="Model calls"
              note={
                view.totals.calls
                  ? `${formatCost(view.totals.cost / view.totals.calls)} each on average`
                  : undefined
              }
              value={view.totals.calls.toLocaleString()}
            />
          </div>
          <section className={cn(cardClass, 'px-4 pt-3 pb-3')}>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <p className="text-[length:var(--text-body)] font-medium">
                {every} {metric === 'cost' ? 'cost' : 'tokens'}
              </p>
              <div className="flex flex-wrap gap-2">
                <Pills
                  label="Measure"
                  onChange={setMetric}
                  options={METRICS}
                  size="sm"
                  value={metric}
                />
                <Pills
                  label="Split by"
                  onChange={setSplit}
                  options={SPLITS}
                  size="sm"
                  value={split}
                />
              </div>
            </div>
            {view.rows.length ? (
              <>
                <StackedColumns
                  format={format}
                  name={name(split)}
                  series={view.series}
                  slots={view.slots}
                  tick={tick}
                />
                <Legend keys={view.series.keys} name={name(split)} slots={view.slots} />
              </>
            ) : (
              <p className="py-12 text-center text-[length:var(--text-secondary)] text-muted">
                No model calls {shown === 'all' ? 'yet' : `in the last ${rangeLabel}`}.
              </p>
            )}
          </section>
          {view.groups.length ? (
            <Group
              description={
                split === 'place'
                  ? undefined
                  : `Choose a ${split === 'bot' ? 'bot' : 'model'} to see only its usage.`
              }
              title={split === 'bot' ? 'By bot' : split === 'model' ? 'By model' : 'Where it went'}
            >
              <div className={dividerClass}>
                {view.groups.map(group => {
                  const selected =
                    split === 'bot' ? bot === group.key : split === 'model' && model === group.key

                  const slot = view.slots.get(group.key)

                  const shown =
                    view.series.keys.includes(group.key) || view.series.keys.includes(OTHER)

                  const top = view.topOf(group)

                  const detail = [
                    `${formatTokens(group.tokens)} tokens`,
                    `${group.calls.toLocaleString()} ${group.calls === 1 ? 'call' : 'calls'}`,
                    split === 'model' &&
                      modelParts(group.key).provider &&
                      providerName(modelParts(group.key).provider),
                    top &&
                      (split === 'bot' ? `mostly ${modelName(top)}` : `mostly ${name('bot')(top)}`)
                  ].filter(Boolean)

                  const content = (
                    <>
                      <span
                        aria-hidden
                        className="size-2.5 shrink-0 rounded-[3px]"
                        style={
                          shown
                            ? { background: slotColor(slot), opacity: slotOpacity(slot) }
                            : undefined
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[length:var(--text-body)]">
                          {name(split)(group.key)}
                        </span>
                        <span className="block truncate text-[length:var(--text-secondary)] text-muted">
                          {detail.join(' · ')}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block font-mono text-[length:var(--text-secondary)] tabular-nums">
                          {metric === 'cost' ? formatCost(group.cost) : formatTokens(group.tokens)}
                        </span>
                        <span className="block text-[length:var(--text-meta)] text-muted tabular-nums">
                          {formatShare(group.share)}
                        </span>
                      </span>
                      {split !== 'place' ? (
                        <span className="flex w-4 shrink-0 justify-end">
                          {selected ? <Check aria-hidden size={14} /> : null}
                        </span>
                      ) : null}
                    </>
                  )

                  return split === 'place' ? (
                    <div
                      className="flex min-h-[52px] items-center gap-3 px-4 py-2.5"
                      key={group.key}
                    >
                      {content}
                    </div>
                  ) : (
                    <button
                      aria-pressed={selected}
                      className="flex min-h-[52px] w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-foreground/[0.04] hex-focus"
                      key={group.key}
                      onClick={() => filterBy(split, selected ? null : group.key)}
                      type="button"
                    >
                      {content}
                    </button>
                  )
                })}
              </div>
            </Group>
          ) : null}
          {view.totals.tokens ? <TokenMix totals={view.totals} /> : null}
        </div>
      )}
    </>
  )
}
