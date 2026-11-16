/**
 * Settings, Usage, for the web and the mobile app: the window to ask the
 * daemon for, and the totals, rankings and stacked series drawn from its rows.
 * Pure functions, so both apps chart the same numbers.
 */
import type { UsagePlace, UsageReportRow } from './types'

export type UsageRange = 'all' | 'day' | 'month' | 'quarter' | 'week'
export type UsageMetric = 'cost' | 'tokens'
export type UsageDimension = 'bot' | 'model' | 'place'

export const USAGE_RANGES: { key: UsageRange; label: string; short: string }[] = [
  { key: 'day', label: '24 hours', short: '24h' },
  { key: 'week', label: '7 days', short: '7d' },
  { key: 'month', label: '30 days', short: '30d' },
  { key: 'quarter', label: '90 days', short: '90d' },
  { key: 'all', label: 'All time', short: 'All' }
]

export const PLACE_LABELS: Record<UsagePlace, string> = {
  chat: 'Chats',
  thread: 'Between bots',
  room: 'Rooms',
  job: 'Scheduled jobs',
  subagent: 'Subagents',
  heartbeat: 'Heartbeat',
  dream: 'Dreaming',
  other: 'Other'
}

const HOUR = 3600
/** Past this many buckets, days are drawn as weeks. */
const MAX_BUCKETS = 120

/** Series past the top five fold into this key. */
export const OTHER = '\u0000other'
/** Series colours: five slots, then Other in a neutral. */
export const SERIES_SLOTS = 5

export interface UsageWindow {
  /** Bucket starts, then the window's end: what `hexbot.usage.report` takes. */
  edges: number[]
  grain: 'day' | 'hour'
  /** Leave out the empty buckets before the first use, for all time. */
  trim: boolean
}

const seconds = (date: Date) => Math.floor(date.getTime() / 1000)

/**
 * The buckets for a range, ending now: the last 24 hours by the hour, or the
 * last 7, 30 or 90 days by local day. Edges are computed here, where the
 * time zone is known, so a day stays midnight to midnight across
 * daylight-saving changes. The first bucket is the part of an hour or day
 * the window starts in.
 */
export function usageWindow(range: UsageRange, now = new Date()): UsageWindow {
  const until = seconds(now)
  const days = { all: 0, day: 0, month: 30, quarter: 90, week: 7 }[range]

  const start =
    range === 'all'
      ? // All time starts before any Hexbot install.
        new Date(2020, 0, 1)
      : range === 'day'
        ? new Date(now.getTime() - 24 * HOUR * 1000)
        : new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate() - days,
            now.getHours(),
            now.getMinutes(),
            now.getSeconds()
          )

  const edges = [seconds(start)]

  if (range === 'day') {
    // Each local hour from the calendar, so a half-hour clock change keeps hours on the hour;
    // a skipped hour lands on one already listed, and a repeated hour joins the one before.
    const [year, month, date, hour] = [
      start.getFullYear(),
      start.getMonth(),
      start.getDate(),
      start.getHours()
    ]

    for (let step = 1; ; step++) {
      const t = seconds(new Date(year, month, date, hour + step))

      if (t >= until) {
        break
      }

      if (t > edges.at(-1)!) {
        edges.push(t)
      }
    }
  } else {
    // Each midnight on its own: where a clock change skips midnight, that day starts at 1 AM,
    // and stepping from it would carry 1 AM into every day after.
    for (let day = 1; ; day++) {
      const t = seconds(new Date(start.getFullYear(), start.getMonth(), start.getDate() + day))

      if (t >= until) {
        break
      }

      edges.push(t)
    }
  }

  edges.push(until)

  return { edges, grain: range === 'day' ? 'hour' : 'day', trim: range === 'all' }
}

export interface UsageFilter {
  bot?: null | string
  model?: null | string
}

/** A model's key: the same name through two providers is two models. */
export const modelKey = (row: Pick<UsageReportRow, 'model' | 'provider'>) =>
  `${row.provider}\u0000${row.model}`

export function modelParts(key: string): { model: string; provider: string } {
  const [provider = '', model = ''] = key.split('\u0000')

  return { model, provider }
}

/** A model key as people read it. */
export const modelName = (key: string) => modelParts(key).model || 'Unknown model'

/**
 * Names for the model keys shown together: the model alone, or with its
 * provider's name where two providers serve a model of the same name.
 */
export function modelNames(
  keys: string[],
  providerName: (id: string) => string
): Map<string, string> {
  const counts = new Map<string, number>()

  for (const key of keys) {
    counts.set(modelName(key), (counts.get(modelName(key)) ?? 0) + 1)
  }

  return new Map(
    keys.map(key => {
      const { provider } = modelParts(key)

      return [
        key,
        counts.get(modelName(key))! > 1 && provider
          ? `${modelName(key)} · ${providerName(provider)}`
          : modelName(key)
      ]
    })
  )
}

export function keyOf(row: UsageReportRow, dimension: UsageDimension): string {
  return dimension === 'model' ? modelKey(row) : row[dimension]
}

export function filterRows(rows: UsageReportRow[], filter: UsageFilter): UsageReportRow[] {
  return rows.filter(
    row =>
      (!filter.bot || row.bot === filter.bot) && (!filter.model || modelKey(row) === filter.model)
  )
}

export interface UsageTotals {
  cacheRead: number
  cacheWrite: number
  calls: number
  cost: number
  /** Input tokens read from the provider's cache, of all input; null without input. */
  hitRate: null | number
  input: number
  output: number
  /** Every token a model processed: input, cache reads and writes, and output. */
  tokens: number
}

const tokensOf = (row: UsageReportRow) => row.input + row.cache_read + row.cache_write + row.output

export const metricOf = (row: UsageReportRow, metric: UsageMetric) =>
  metric === 'cost' ? row.cost : tokensOf(row)

export function totalsOf(rows: UsageReportRow[]): UsageTotals {
  const totals = { cacheRead: 0, cacheWrite: 0, calls: 0, cost: 0, input: 0, output: 0 }

  for (const row of rows) {
    totals.cacheRead += row.cache_read
    totals.cacheWrite += row.cache_write
    totals.calls += row.calls
    totals.cost += row.cost
    totals.input += row.input
    totals.output += row.output
  }

  const allInput = totals.input + totals.cacheRead + totals.cacheWrite

  return {
    ...totals,
    hitRate: allInput ? totals.cacheRead / allInput : null,
    tokens: allInput + totals.output
  }
}

export interface UsageGroup extends UsageTotals {
  key: string
  /** This group's part of the metric it was ranked by, 0 to 1. */
  share: number
}

/** Rows grouped by bot, model or place, largest first by `metric`. */
export function groupsOf(
  rows: UsageReportRow[],
  dimension: UsageDimension,
  metric: UsageMetric = 'cost'
): UsageGroup[] {
  const grouped = new Map<string, UsageReportRow[]>()

  for (const row of rows) {
    const key = keyOf(row, dimension)
    const list = grouped.get(key)

    if (list) {
      list.push(row)
    } else {
      grouped.set(key, [row])
    }
  }

  const groups = [...grouped].map(([key, list]) => ({ key, ...totalsOf(list), share: 0 }))
  const whole = groups.reduce((sum, group) => sum + group[metric], 0)

  for (const group of groups) {
    group.share = whole ? group[metric] / whole : 0
  }

  return groups.sort(
    (a, b) => b[metric] - a[metric] || b.tokens - a.tokens || a.key.localeCompare(b.key)
  )
}

/**
 * Colour slots, 0 to 4, for the series shown. A key keeps the slot its rank
 * gives it across every bot and model, so narrowing to one bot never repaints
 * what stays; keys that rank lower take the slots left free.
 */
export function colorSlots(everyKey: string[], shown: string[]): Map<string, number> {
  const slots = new Map<string, number>()
  const free = Array.from({ length: SERIES_SLOTS }, (_, slot) => slot)

  for (const key of shown) {
    const rank = everyKey.indexOf(key)

    if (rank >= 0 && rank < SERIES_SLOTS) {
      slots.set(key, rank)
      free.splice(free.indexOf(rank), 1)
    }
  }

  for (const key of shown) {
    if (!slots.has(key) && free.length) {
      slots.set(key, free.shift()!)
    }
  }

  return slots
}

export interface UsageBucket {
  t: number
  /** Where the bucket ends, the next bucket's start. */
  end: number
  /** An hour, a local day, or a week of days. */
  grain: 'day' | 'hour' | 'week'
  total: number
  values: Record<string, number>
}

export interface UsageSeries {
  buckets: UsageBucket[]
  /** The keys drawn, largest first, with `OTHER` last when the rest folds into it. */
  keys: string[]
}

/** Values by series key, with no inherited keys: a bot may be called `constructor`. */
const emptyValues = () => Object.create(null) as Record<string, number>

/**
 * One stacked bucket per hour or day of the window, empty ones included,
 * split into the top five `dimension` keys and Other.
 */
export function seriesOf(
  window: UsageWindow,
  rows: UsageReportRow[],
  dimension: UsageDimension,
  metric: UsageMetric
): UsageSeries {
  const ranked = groupsOf(rows, dimension, metric).filter(group => group[metric] > 0)
  const top = new Set(ranked.slice(0, SERIES_SLOTS).map(group => group.key))
  const keys = ranked.length > SERIES_SLOTS ? [...top, OTHER] : [...top]
  const { edges } = window

  let buckets: UsageBucket[] = edges.slice(0, -1).map((t, i) => ({
    end: edges[i + 1]!,
    grain: window.grain,
    t,
    total: 0,
    values: emptyValues()
  }))

  const index = new Map(buckets.map(bucket => [bucket.t, bucket]))

  for (const row of rows) {
    const bucket = index.get(row.t)
    const value = metricOf(row, metric)

    if (!bucket || !value) {
      continue
    }

    const key = top.has(keyOf(row, dimension)) ? keyOf(row, dimension) : OTHER

    bucket.values[key] = (bucket.values[key] ?? 0) + value
    bucket.total += value
  }

  if (window.trim) {
    const first = buckets.findIndex(bucket => bucket.total > 0)

    buckets = first < 0 ? buckets.slice(-1) : buckets.slice(first)
  }

  if (buckets.length > MAX_BUCKETS) {
    const weeks: UsageBucket[] = []

    for (let i = 0; i < buckets.length; i += 7) {
      const days = buckets.slice(i, i + 7)

      const week: UsageBucket = {
        end: days.at(-1)!.end,
        grain: 'week',
        t: days[0]!.t,
        total: 0,
        values: emptyValues()
      }

      for (const day of days) {
        week.total += day.total

        for (const key in day.values) {
          week.values[key] = (week.values[key] ?? 0) + day.values[key]!
        }
      }

      weeks.push(week)
    }

    buckets = weeks
  }

  return { buckets, keys }
}

const UNITS: [number, string][] = [
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K']
]

/**
 * 12.9K, 329.1M, 1.2B for a positive value. Written out because Hermes, which
 * runs the mobile app, ignores `Intl.NumberFormat`'s compact notation.
 */
function compact(value: number): string {
  for (const [size, unit] of UNITS) {
    const scaled = Math.round((value / size) * 10) / 10

    if (scaled >= 1) {
      return `${scaled}${unit}`
    }
  }

  return String(Math.round(value))
}

/** 9,876 in full; 12.9K, 329M and 1.2B past ten thousand. */
export function formatTokens(value: number): string {
  return value < 10_000 ? Math.round(value).toLocaleString('en') : compact(value)
}

/** Dollars: cents always, and "<$0.01" for a cost too small to show. */
export function formatCost(value: number): string {
  if (value > 0 && value < 0.005) {
    return '<$0.01'
  }

  return `$${value.toLocaleString('en', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`
}

/** An axis tick: $0, $0.50, $12, $1.2K. */
export function formatCostTick(value: number): string {
  if (value >= 1000) {
    return `$${compact(value)}`
  }

  return `$${value < 10 && value % 1 ? value.toFixed(2) : Math.round(value)}`
}

export const formatShare = (share: number) =>
  share > 0 && share < 0.005 ? '<1%' : `${Math.round(share * 100)}%`

/** A bucket as people read it: "2 PM", "Nov 16", or "Nov 10 – Nov 16". */
export function bucketLabel(
  bucket: Pick<UsageBucket, 'end' | 'grain' | 't'>,
  locale?: string
): string {
  const day = (t: number) =>
    new Date(t * 1000).toLocaleDateString(locale, { day: 'numeric', month: 'short' })

  if (bucket.grain === 'hour') {
    return new Date(bucket.t * 1000).toLocaleTimeString(locale, { hour: 'numeric' })
  }

  const last = day(bucket.end - 1)

  // The last week of a long history can be a single day.
  return bucket.grain === 'day' || last === day(bucket.t)
    ? day(bucket.t)
    : `${day(bucket.t)} – ${last}`
}

/**
 * Usage from before the native runtime, as all time shows it. It has no day,
 * so it sits beside the chart; null for other ranges or when there is none.
 */
export function earlierNote(
  earlier: undefined | { cost: number; tokens: number },
  range: UsageRange
): null | string {
  if (range !== 'all' || !earlier || (earlier.cost <= 0 && earlier.tokens <= 0)) {
    return null
  }

  const tokens = `${formatTokens(earlier.tokens)} tokens`
  // A free or local model's tokens count too, though they cost nothing.
  const what = earlier.cost > 0 ? `${formatCost(earlier.cost)} for ${tokens}` : tokens

  return `Plus ${what} recorded by an earlier version, without dates.`
}

/** An SVG path for a column segment; `round` rounds its top corners, the baseline end stays square. */
export function columnPath(x: number, y: number, w: number, h: number, round = 0): string {
  const r = Math.min(round, w / 2, h)

  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
}

/** A round top for a value axis, so ticks land on 1, 2 or 5 times a power of ten. */
export function niceTop(value: number): number {
  if (value <= 0) {
    return 1
  }

  const power = 10 ** Math.floor(Math.log10(value))

  return ([1, 2, 2.5, 5, 10].find(step => step * power >= value) ?? 10) * power
}

/**
 * How a window's cost compares with the window before it, as the end of a
 * sentence: "up from $5.83 in the previous 30 days". Null for all time, or
 * when nothing was spent before.
 */
export function costComparison(
  current: number,
  previous: null | number | undefined,
  range: UsageRange
): null | string {
  if (!previous || range === 'all') {
    return null
  }

  const window = range === 'day' ? '24 hours' : USAGE_RANGES.find(r => r.key === range)!.label
  const same = formatCost(current) === formatCost(previous)

  return `${same ? 'the same as' : current > previous ? 'up from' : 'down from'} ${formatCost(previous)} in the previous ${window}`
}
