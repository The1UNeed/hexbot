import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { UsageReportRow } from './types'
import {
  bucketLabel,
  colorSlots,
  costComparison,
  earlierNote,
  filterRows,
  formatCost,
  formatTokens,
  groupsOf,
  modelKey,
  modelName,
  modelNames,
  OTHER,
  seriesOf,
  totalsOf,
  usageWindow,
  type UsageWindow
} from './usage-report'

const DAY = 86_400

const row = (patch: Partial<UsageReportRow>): UsageReportRow => ({
  bot: 'owl',
  cache_read: 0,
  cache_write: 0,
  calls: 1,
  cost: 1,
  input: 10,
  model: 'm1',
  output: 1,
  place: 'chat',
  provider: 'p',
  t: 0,
  ...patch
})

describe('usageWindow', () => {
  const zone = process.env.TZ

  beforeEach(() => {
    // Daylight saving in New York ends on Sunday, November 1, 2026.
    process.env.TZ = 'America/New_York'
  })

  afterEach(() => {
    process.env.TZ = zone
  })

  it('ends now and starts exactly the range before it', () => {
    const now = new Date(2026, 10, 16, 15, 30)
    const window = usageWindow('month', now)
    const start = new Date(window.edges[0]! * 1000)

    expect(window.edges.at(-1)).toBe(now.getTime() / 1000)
    expect([start.getMonth(), start.getDate(), start.getHours(), start.getMinutes()]).toEqual([
      9, 17, 15, 30
    ])
    expect(window.edges).toHaveLength(32)
    expect(usageWindow('day', now).edges[0]).toBe(now.getTime() / 1000 - 24 * 3600)
  })

  it('keeps days midnight to midnight across a daylight-saving change', () => {
    const window = usageWindow('week', new Date(2026, 10, 4, 12))
    const days = window.edges.slice(1, -1).map(t => new Date(t * 1000))

    expect(days.map(d => d.getHours())).toEqual(days.map(() => 0))
    expect(days.map(d => d.getDate())).toEqual([29, 30, 31, 1, 2, 3, 4])

    // 00:30 on Oct 31 is that day's, not the day before's.
    const late = new Date(2026, 9, 31, 0, 30).getTime() / 1000
    const edge = window.edges.filter(t => t <= late).at(-1)!

    expect(new Date(edge * 1000).getDate()).toBe(31)
    // November 1 has 25 hours.
    expect(window.edges[5]! - window.edges[4]!).toBe(25 * 3600)
  })

  it('starts the hours after the window even in the hour clocks repeat', () => {
    // 1:30 AM EST on November 1, the second time 1:30 comes round that night.
    const start = Date.UTC(2026, 10, 1, 6, 30) / 1000
    const window = usageWindow('day', new Date((start + 24 * 3600) * 1000))

    expect(window.edges[0]).toBe(start)
    expect(window.edges[1]).toBe(start + 30 * 60)
    expect(window.edges.every((t, i) => i === 0 || t > window.edges[i - 1]!)).toBe(true)
  })

  it('keeps hours on the hour where clocks move by half an hour', () => {
    // Lord Howe Island goes from 2:00 to 2:30 on October 4, 2026.
    process.env.TZ = 'Australia/Lord_Howe'
    const window = usageWindow('day', new Date(2026, 9, 4, 12, 15))
    const hours = window.edges.slice(1, -1).map(t => new Date(t * 1000))

    expect(hours.filter(d => d.getMinutes() !== 0).map(d => d.getHours())).toEqual([2])
    expect(hours.some(d => d.getHours() === 3 && d.getMinutes() === 0)).toBe(true)
    expect(window.edges.every((t, i) => i === 0 || t > window.edges[i - 1]!)).toBe(true)
  })

  it('keeps later days at midnight where a clock change skips one', () => {
    // Havana springs forward at midnight: March 8, 2026 starts at 1 AM.
    process.env.TZ = 'America/Havana'
    const window = usageWindow('all', new Date(2026, 10, 16, 12))
    const days = window.edges.slice(1, -1).map(t => new Date(t * 1000))
    const late = days.filter(d => d.getHours() !== 0)

    expect(late.length).toBeGreaterThan(0)
    expect(late.every(d => d.getHours() === 1)).toBe(true)

    const november = days.find(
      d => d.getMonth() === 10 && d.getDate() === 15 && d.getFullYear() === 2026
    )!

    expect(november.getHours()).toBe(0)
  })

  it('counts hours over a day and starts all time in 2020', () => {
    const now = new Date(2026, 10, 16, 15, 30)
    const day = usageWindow('day', now)

    expect(day.grain).toBe('hour')
    expect(day.edges).toHaveLength(26)
    expect(new Date(day.edges[1]! * 1000).getMinutes()).toBe(0)
    const all = usageWindow('all', now)

    expect(new Date(all.edges[0]! * 1000).getFullYear()).toBe(2020)
    expect(all.trim).toBe(true)
  })
})

describe('totals and groups', () => {
  const rows = [
    row({ bot: 'owl', cache_read: 90, cost: 3, model: 'big' }),
    row({ bot: 'fox', cost: 1, model: 'big', provider: 'q' }),
    row({ bot: 'fox', cost: 0, model: 'small', output: 1000 })
  ]

  it('counts cached input as input and gives a hit rate', () => {
    const totals = totalsOf(rows)

    expect(totals.cost).toBe(4)
    expect(totals.tokens).toBe(30 + 90 + 1002)
    expect(totals.hitRate).toBeCloseTo(90 / 120)
    expect(totalsOf([]).hitRate).toBeNull()
  })

  it('ranks by the metric and keeps one model per provider', () => {
    expect(groupsOf(rows, 'bot').map(g => [g.key, g.share])).toEqual([
      ['owl', 0.75],
      ['fox', 0.25]
    ])
    expect(groupsOf(rows, 'bot', 'tokens')[0]!.key).toBe('fox')
    expect(groupsOf(rows, 'model')).toHaveLength(3)
    expect(modelName(modelKey({ model: 'big', provider: 'q' }))).toBe('big')
    expect(modelName(modelKey({ model: '', provider: '' }))).toBe('Unknown model')
  })

  it('names a model by its provider only when another shown model shares its name', () => {
    const codex = modelKey({ model: 'gpt-6.1-sol', provider: 'openai-codex' })
    const copilot = modelKey({ model: 'gpt-6.1-sol', provider: 'github-copilot' })
    const kimi = modelKey({ model: 'kimi-k2.6', provider: 'openrouter' })

    const label = (id: string) =>
      ({ 'github-copilot': 'GitHub Copilot', 'openai-codex': 'ChatGPT' })[id] ?? id

    expect([...modelNames([codex, copilot, kimi], label).values()]).toEqual([
      'gpt-6.1-sol · ChatGPT',
      'gpt-6.1-sol · GitHub Copilot',
      'kimi-k2.6'
    ])
  })

  it('filters by bot and model together', () => {
    expect(filterRows(rows, { bot: 'fox' })).toHaveLength(2)
    expect(filterRows(rows, { bot: 'fox', model: modelKey(rows[2]!) })).toEqual([rows[2]])
  })
})

describe('seriesOf', () => {
  const window: UsageWindow = {
    edges: [10 * DAY, 11 * DAY, 12 * DAY, 12 * DAY + 5],
    grain: 'day',
    trim: false
  }

  it('fills empty days and folds the tail into Other', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((bot, i) =>
      row({ bot, cost: 10 - i, t: 10 * DAY })
    )

    const series = seriesOf(window, rows, 'bot', 'cost')

    expect(series.buckets.map(b => b.t)).toEqual([10 * DAY, 11 * DAY, 12 * DAY])
    expect(series.keys).toEqual(['a', 'b', 'c', 'd', 'e', OTHER])
    expect(series.buckets[0]!.values[OTHER]).toBe(4 + 5)
    expect(series.buckets[0]!.total).toBe(10 + 9 + 8 + 7 + 6 + 5 + 4)
    expect(series.buckets[1]!.total).toBe(0)
  })

  it('charts a bot called constructor', () => {
    const series = seriesOf(
      window,
      [row({ bot: 'constructor', cost: 2, t: 10 * DAY })],
      'bot',
      'cost'
    )

    expect(series.buckets[0]!.values.constructor).toBe(2)
  })

  it('starts all time at the first use and draws long histories as weeks', () => {
    const edges = Array.from({ length: 401 }, (_, i) => i * DAY)
    const rows = [row({ t: 100 * DAY }), row({ t: 399 * DAY })]
    const series = seriesOf({ edges, grain: 'day', trim: true }, rows, 'bot', 'cost')

    expect(series.buckets[0]!.t).toBe(100 * DAY)
    expect(series.buckets[0]!.grain).toBe('week')
    expect(series.buckets[0]!.end).toBe(107 * DAY)
    expect(series.buckets.reduce((sum, b) => sum + b.total, 0)).toBe(2)
  })
})

describe('colorSlots', () => {
  it('keeps a key’s slot when a filter hides the others', () => {
    const every = ['a', 'b', 'c', 'd', 'e', 'f']

    expect([...colorSlots(every, ['c', 'f'])]).toEqual([
      ['c', 2],
      ['f', 0]
    ])
  })
})

describe('formats', () => {
  it('reads like the rest of Hexbot', () => {
    expect(formatTokens(9876)).toBe('9,876')
    expect(formatTokens(329_148_754)).toBe('329.1M')
    expect(formatCost(120.705)).toBe('$120.71')
    expect(formatCost(0.001)).toBe('<$0.01')
    expect(formatCost(0)).toBe('$0.00')
    expect(costComparison(115.03, 5.83, 'month')).toBe('up from $5.83 in the previous 30 days')
    expect(costComparison(1, 2, 'day')).toBe('down from $2.00 in the previous 24 hours')
    expect(costComparison(1, 0, 'week')).toBeNull()
    expect(costComparison(1, 2, 'all')).toBeNull()
    expect(earlierNote({ cost: 0.33, tokens: 363 }, 'all')).toBe(
      'Plus $0.33 for 363 tokens recorded by an earlier version, without dates.'
    )
    expect(earlierNote({ cost: 0, tokens: 2_100_000 }, 'all')).toBe(
      'Plus 2.1M tokens recorded by an earlier version, without dates.'
    )
    expect(earlierNote({ cost: 0.33, tokens: 363 }, 'month')).toBeNull()
    expect(earlierNote({ cost: 0, tokens: 0 }, 'all')).toBeNull()
    const monday = new Date(2026, 10, 10).getTime() / 1000

    expect(bucketLabel({ end: monday + 7 * DAY, grain: 'week', t: monday }, 'en-US')).toBe(
      'Nov 10 – Nov 16'
    )
    expect(bucketLabel({ end: monday + DAY, grain: 'week', t: monday }, 'en-US')).toBe('Nov 10')
  })
})
