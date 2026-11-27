import { Ionicons } from '@expo/vector-icons'
import { useEffect, useMemo, useRef, useState } from 'react'
import { type GestureResponderEvent, Platform, Pressable, StyleSheet, View } from 'react-native'
import Svg, { Line, Path, Text as SvgText } from 'react-native-svg'

import type { UsagePlace, UsageReport, UsageSummary } from '../../web/src/lib/types'
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
  modelName,
  modelNames,
  modelParts,
  niceTop,
  OTHER,
  PLACE_LABELS,
  usageWindow,
  seriesOf,
  totalsOf,
  USAGE_RANGES,
  type UsageDimension,
  type UsageMetric,
  type UsageRange,
  type UsageSeries,
  type UsageTotals,
  type UsageWindow
} from '../../web/src/lib/usage-report'
import { unknownMethod } from './core/chat-send'
import type { useMobile } from './core/useMobile'
import { Banner, Group, mono, radius, Row, Segmented, Text, useTheme } from './ui'

type Mobile = ReturnType<typeof useMobile>

/** Axis labels in the system face; the web's SVG default is a serif. */
const axisFont = Platform.select({
  default: undefined,
  web: '-apple-system, system-ui, sans-serif'
})

const OTHER_LABEL: Record<UsageDimension, string> = {
  bot: 'Other bots',
  model: 'Other models',
  place: 'Other places'
}

/** A series colour: its slot, or a muted grey for Other. */
function useSlotColor() {
  const theme = useTheme()

  return (slot: number | undefined) =>
    slot == null ? { color: theme.muted, opacity: 0.45 } : { color: theme.chart[slot]!, opacity: 1 }
}

function Tile({ label, note, value }: { label: string; note?: string; value: string }) {
  const theme = useTheme()

  return (
    <View
      style={[styles.tile, { backgroundColor: theme.surface, borderColor: theme.chromeBorder }]}
    >
      <Text numberOfLines={1} tone="muted" variant="caption">
        {label}
      </Text>
      <Text maxFontSizeMultiplier={1.3} numberOfLines={1} style={styles.tileValue} variant="title">
        {value}
      </Text>
      {note ? (
        <Text numberOfLines={1} tone="muted" variant="caption">
          {note}
        </Text>
      ) : null}
    </View>
  )
}

/** Columns over time. Tap or drag across them to read one; the legend then shows its values. */
function Columns({
  format,
  onSelect,
  selected,
  series,
  slots,
  tick
}: {
  /** Values as the header and legend print them; `tick` is for the axis. */
  format: (value: number) => string
  onSelect: (index: null | number) => void
  selected: null | number
  series: UsageSeries
  slots: Map<string, number>
  tick: (value: number) => string
}) {
  const theme = useTheme()
  const slotColor = useSlotColor()
  const [width, setWidth] = useState(0)
  const height = 168
  const left = 44
  const bottom = 20
  const top = 8
  const { buckets, keys } = series
  // Only a column this chart has; a stale choice reads as none.
  const chosen = selected != null && selected < buckets.length ? selected : null
  const plotWidth = Math.max(0, width - left)
  const plotHeight = height - bottom - top
  const peak = niceTop(Math.max(0, ...buckets.map(b => b.total)))
  const band = buckets.length ? plotWidth / buckets.length : 0
  const barWidth = Math.max(1, Math.min(20, band * 0.68))
  const y = (value: number) => top + plotHeight - (value / peak) * plotHeight
  const xOf = (index: number) => left + band * index + (band - barWidth) / 2
  const labelled =
    buckets.length > 2
      ? [0, Math.floor((buckets.length - 1) / 2), buckets.length - 1]
      : buckets.map((_, i) => i)

  const total = (index: number) =>
    `${bucketLabel(buckets[index]!)}, ${format(buckets[index]!.total)}`
  const step = (by: number) =>
    onSelect(Math.min(buckets.length - 1, Math.max(0, (chosen ?? buckets.length) + by)))

  const pick = (event: GestureResponderEvent) => {
    const index = Math.floor((event.nativeEvent.locationX - left) / Math.max(1, band))

    if (index >= 0 && index < buckets.length) {
      onSelect(index)
    }
  }

  // Where the touch began, to tell a tap or a sideways drag from a swipe that scrolls the page.
  const start = useRef({ x: 0, y: 0 })
  const moved = (event: GestureResponderEvent) => ({
    x: Math.abs(event.nativeEvent.pageX - start.current.x),
    y: Math.abs(event.nativeEvent.pageY - start.current.y)
  })

  return (
    <View
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      accessibilityHint="Swipe up or down to read each column"
      accessibilityLabel={`${buckets.length} columns, highest ${format(Math.max(0, ...buckets.map(b => b.total)))}`}
      accessibilityRole="adjustable"
      accessibilityValue={{ text: chosen == null ? 'None chosen' : total(chosen) }}
      accessible
      onAccessibilityAction={event => step(event.nativeEvent.actionName === 'increment' ? 1 : -1)}
      onLayout={event => setWidth(event.nativeEvent.layout.width)}
      // A tap or a sideways drag reads a column. A vertical swipe is left to the page's
      // scroll view and chooses none.
      onResponderGrant={event => {
        start.current = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY }
      }}
      onResponderMove={event => {
        const { x, y } = moved(event)
        if (x > y) pick(event)
      }}
      onResponderRelease={event => {
        if (moved(event).y < 10) pick(event)
      }}
      onStartShouldSetResponder={() => true}
      style={{ height }}
      testID="usage-chart"
    >
      {width > 0 ? (
        <Svg height={height} width={width}>
          {[0, 0.5, 1].map(f => (
            <Line
              key={`grid-${f}`}
              stroke={theme.hairline}
              strokeWidth={StyleSheet.hairlineWidth}
              x1={left}
              x2={left + plotWidth}
              y1={y(peak * f)}
              y2={y(peak * f)}
            />
          ))}
          {[0, 0.5, 1].map(f => (
            <SvgText
              fontFamily={axisFont}
              fill={theme.muted}
              fontSize={11}
              key={`tick-${f}`}
              textAnchor="end"
              x={left - 6}
              y={y(peak * f) + 4}
            >
              {tick(peak * f)}
            </SvgText>
          ))}
          {buckets.map((bucket, index) => {
            let base = bucket.total
            const drawn = keys.filter(key => (bucket.values[key] ?? 0) > 0)
            const dim = chosen != null && chosen !== index

            return drawn.map((key, at) => {
              const value = bucket.values[key] ?? 0
              const yTop = y(base)
              const full = y(base - value) - yTop
              base -= value
              const h = at === drawn.length - 1 ? full : Math.max(0, full - 2)
              const { color, opacity } = slotColor(key === OTHER ? undefined : slots.get(key))

              return h > 0 ? (
                <Path
                  d={columnPath(xOf(index), yTop, barWidth, h, at === 0 ? 3 : 0)}
                  fill={color}
                  fillOpacity={opacity * (dim ? 0.4 : 1)}
                  key={`${bucket.t}-${key}`}
                />
              ) : null
            })
          })}
          {labelled.map(index => (
            <SvgText
              fontFamily={axisFont}
              fill={theme.muted}
              fontSize={11}
              key={`label-${index}`}
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
            </SvgText>
          ))}
        </Svg>
      ) : null}
    </View>
  )
}

const TOKEN_PARTS: { key: keyof UsageTotals; label: string; opacity: number; slot: number }[] = [
  { key: 'input', label: 'Not cached', opacity: 1, slot: 0 },
  { key: 'cacheRead', label: 'Read from cache', opacity: 0.55, slot: 0 },
  { key: 'cacheWrite', label: 'Written to cache', opacity: 0.3, slot: 0 },
  { key: 'output', label: 'Output', opacity: 0.8, slot: 1 }
]

function TokenMix({ totals }: { totals: UsageTotals }) {
  const theme = useTheme()
  const parts = TOKEN_PARTS.map(part => ({ ...part, value: totals[part.key] as number }))
  const share = (value: number) => formatShare(totals.tokens ? value / totals.tokens : 0)

  return (
    <Group
      footer="Input the provider reads from its cache costs a fraction of new input."
      title="Tokens by kind"
    >
      <View
        accessibilityLabel={parts
          .map(part => `${part.label} ${formatTokens(part.value)}, ${share(part.value)}`)
          .join('; ')}
        accessible
        style={styles.mix}
      >
        <View style={styles.mixBar}>
          {parts
            .filter(part => part.value > 0)
            .map(part => (
              <View
                key={part.key}
                style={[
                  styles.mixPart,
                  {
                    backgroundColor: theme.chart[part.slot],
                    flexGrow: part.value,
                    opacity: part.opacity
                  }
                ]}
              />
            ))}
        </View>
        <View style={styles.mixLegend}>
          {parts.map(part => (
            <View key={part.key} style={styles.mixItem}>
              <View style={styles.legendLine}>
                <View
                  style={[
                    styles.swatch,
                    { backgroundColor: theme.chart[part.slot], opacity: part.opacity }
                  ]}
                />
                <Text tone="muted" variant="caption">
                  {part.label}
                </Text>
              </View>
              <Text variant="footnote">
                {formatTokens(part.value)}{' '}
                <Text tone="muted" variant="footnote">
                  {share(part.value)}
                </Text>
              </Text>
            </View>
          ))}
        </View>
      </View>
    </Group>
  )
}

/** A daemon from before `hexbot.usage.report`: its totals only. */
function SummaryOnly({ summary }: { summary: UsageSummary }) {
  return (
    <Group footer="Update this daemon to see usage over time, by bot and model, and where it went.">
      <Row meta={summary.input_tokens.toLocaleString()} testID="usage-input" title="Input tokens" />
      <Row
        meta={summary.output_tokens.toLocaleString()}
        testID="usage-output"
        title="Output tokens"
      />
      <Row
        meta={formatCost(summary.estimated_cost_usd)}
        testID="usage-cost"
        title="Estimated cost"
      />
    </Group>
  )
}

/** Settings, Usage: cost and tokens over time, by bot, model, and kind of work. */
export function Usage({ mobile }: { mobile: Mobile }) {
  const theme = useTheme()
  const slotColor = useSlotColor()
  const [range, setRange] = useState<UsageRange>('month')
  // The report with the range and window it was asked for, so its labels stay right when a newer request fails.
  const [loaded, setLoaded] = useState<null | {
    range: UsageRange
    report: UsageReport
    window: UsageWindow
  }>(null)
  const [summary, setSummary] = useState<null | UsageSummary>(null)
  const [error, setError] = useState<null | string>(null)
  const [loading, setLoading] = useState(true)
  const [bot, setBot] = useState<null | string>(null)
  const [model, setModel] = useState<null | string>(null)
  const [split, setSplit] = useState<UsageDimension>('bot')
  const [metric, setMetric] = useState<UsageMetric>('cost')
  const [selected, setSelected] = useState<null | number>(null)
  const [providers, setProviders] = useState<{ id: string; label: string }[]>([])

  useEffect(() => {
    // Provider names for models; their ids stand in until they load.
    mobile
      .rpc<{ providers: { id: string; label: string }[] }>('hexbot.providers.list')
      .then(result => setProviders(result.providers))
      .catch(() => undefined)
  }, [])

  const providerName = (id: string) => providers.find(provider => provider.id === id)?.label || id

  useEffect(() => {
    let current = true
    setLoading(true)
    setSelected(null)
    const window = usageWindow(range)
    mobile
      .rpc<UsageReport>('hexbot.usage.report', { edges: window.edges })
      .then(report => {
        if (!current) return
        setLoaded({ range, report, window })
        // A column chosen in the last chart may not exist in this one.
        setSelected(null)
        setError(null)
      })
      .catch(async (failure: unknown) => {
        if (!current) return
        const text = (e: unknown) => (e instanceof Error ? e.message : String(e))
        if (!unknownMethod(failure)) {
          setError(text(failure))
          return
        }
        // A daemon from before the report: its totals instead.
        try {
          const older = await mobile.rpc<UsageSummary>('hexbot.usage.summary')
          if (current) setSummary(older)
        } catch (failed) {
          if (current) setError(text(failed))
        }
      })
      .finally(() => current && setLoading(false))
    return () => {
      current = false
    }
  }, [range])

  const view = useMemo(() => {
    if (!loaded) return null
    const { report, window } = loaded
    const rows = filterRows(report.rows, { bot, model })
    const series = seriesOf(window, rows, split, metric)
    const everyKey = groupsOf(report.rows, split, metric).map(group => group.key)

    return {
      groups: groupsOf(rows, split, metric),
      rows,
      series,
      slots: colorSlots(
        everyKey,
        series.keys.filter(key => key !== OTHER)
      ),
      totals: totalsOf(rows)
    }
  }, [bot, loaded, metric, model, split])

  // The chart's models, named apart when two providers serve one of the same name.
  const shownModels = modelNames(
    split === 'model' && view ? view.series.keys.filter(key => key !== OTHER) : [],
    providerName
  )

  const name = (dimension: UsageDimension, key: string) => {
    if (key === OTHER) return OTHER_LABEL[dimension]
    if (dimension === 'bot') {
      const found = mobile.bots.find(b => b.name === key)
      return found?.display_name || key
    }
    return dimension === 'model'
      ? (shownModels.get(key) ?? modelName(key))
      : (PLACE_LABELS[key as UsagePlace] ?? key)
  }

  const filterBy = (dimension: UsageDimension, key: null | string) => {
    setSelected(null)
    if (dimension === 'bot') {
      setBot(key)
      if (key && split === 'bot') setSplit('model')
    } else if (dimension === 'model') {
      setModel(key)
      if (key && split === 'model') setSplit('bot')
    }
  }

  if (summary) return <SummaryOnly summary={summary} />

  if (!view) {
    return (
      <Group footer={error ? `Usage is unavailable: ${error}` : 'Loading usage…'}>
        <View style={styles.placeholder} />
      </Group>
    )
  }

  const format = metric === 'cost' ? formatCost : formatTokens
  const tick = metric === 'cost' ? formatCostTick : formatTokens
  const filtered = Boolean(bot || model)
  const shown = loaded!.range
  const rangeLabel = USAGE_RANGES.find(r => r.key === shown)!.label
  const comparison = filtered
    ? null
    : costComparison(view.totals.cost, loaded!.report.previous.cost, shown)
  const earlier = filtered ? null : earlierNote(loaded!.report.earlier, shown)
  const grain = view.series.buckets[0]?.grain ?? 'day'
  const every = grain === 'hour' ? 'Hourly' : grain === 'week' ? 'Weekly' : 'Daily'
  const active = selected == null ? null : (view.series.buckets[selected] ?? null)

  return (
    <View style={[styles.page, loading && styles.loading]}>
      <Segmented
        onChange={setRange}
        options={USAGE_RANGES.map(r => ({ key: r.key, label: r.short }))}
        selected={range}
        testID="usage-range"
      />
      {error ? (
        <Banner message={`Showing the last report. ${error}`} testID="usage-error" tone="warning" />
      ) : null}
      {filtered ? (
        <View style={styles.chips}>
          {(
            [
              ['bot', bot],
              ['model', model]
            ] as const
          ).map(([dimension, key]) =>
            key ? (
              <Pressable
                accessibilityHint="Shows every bot and model again"
                accessibilityLabel={`Only ${name(dimension, key)}`}
                accessibilityRole="button"
                key={dimension}
                onPress={() => filterBy(dimension, null)}
                style={[styles.chip, { backgroundColor: theme.fill }]}
                testID={`usage-filter-${dimension}`}
              >
                <Text numberOfLines={1} variant="footnote">
                  {name(dimension, key)}
                </Text>
                <Ionicons color={theme.muted} name="close" size={14} />
              </Pressable>
            ) : null
          )}
        </View>
      ) : null}
      <View style={styles.summary}>
        <Text maxFontSizeMultiplier={1.2} style={styles.hero} testID="usage-cost">
          {formatCost(view.totals.cost)}
        </Text>
        <Text tone="muted" variant="footnote">
          Estimated cost{filtered ? ' for this selection' : ''},{' '}
          {shown === 'all' ? 'all time' : `last ${rangeLabel}`}
          {comparison ? `, ${comparison}` : ''}
        </Text>
        {earlier ? (
          <Text tone="muted" variant="footnote">
            {earlier}
          </Text>
        ) : null}
      </View>
      <View style={styles.tiles}>
        <Tile
          label="Tokens"
          note={`${formatTokens(view.totals.output)} output`}
          value={formatTokens(view.totals.tokens)}
        />
        <Tile
          label="Cache hits"
          note={`${formatTokens(view.totals.cacheRead)} cached`}
          value={view.totals.hitRate == null ? '—' : `${Math.round(view.totals.hitRate * 100)}%`}
        />
        <Tile
          label="Model calls"
          note={
            view.totals.calls
              ? `${formatCost(view.totals.cost / view.totals.calls)} each`
              : undefined
          }
          value={formatTokens(view.totals.calls)}
        />
      </View>
      <View
        style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.chromeBorder }]}
      >
        <View style={styles.cardHead}>
          <Text variant="subhead">
            {active ? bucketLabel(active) : `${every} ${metric === 'cost' ? 'cost' : 'tokens'}`}
          </Text>
          <Text style={styles.number} tone="muted" variant="footnote">
            {active ? format(active.total) : ''}
          </Text>
        </View>
        <Segmented
          onChange={next => {
            setMetric(next)
            setSelected(null)
          }}
          options={[
            { key: 'cost', label: 'Cost' },
            { key: 'tokens', label: 'Tokens' }
          ]}
          selected={metric}
          testID="usage-metric"
        />
        <Segmented
          onChange={next => {
            setSplit(next)
            setSelected(null)
          }}
          options={[
            { key: 'bot', label: 'Bots' },
            { key: 'model', label: 'Models' },
            { key: 'place', label: 'Where' }
          ]}
          selected={split}
          testID="usage-split"
        />
        {view.rows.length ? (
          <>
            <Columns
              onSelect={setSelected}
              selected={selected}
              series={view.series}
              slots={view.slots}
              format={format}
              tick={tick}
            />
            <View style={styles.legend}>
              {view.series.keys.map(key => {
                const { color, opacity } = slotColor(
                  key === OTHER ? undefined : view.slots.get(key)
                )
                const value = active?.values[key]

                return active && !value ? null : (
                  <View key={key} style={styles.legendLine}>
                    <View style={[styles.swatch, { backgroundColor: color, opacity }]} />
                    <Text
                      numberOfLines={1}
                      style={styles.legendText}
                      tone="muted"
                      variant="caption"
                    >
                      {value ? `${format(value)} ` : ''}
                      {name(split, key)}
                    </Text>
                  </View>
                )
              })}
            </View>
            {active ? (
              <Pressable
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => setSelected(null)}
                testID="usage-clear-column"
              >
                <Text tone="accent" variant="footnote">
                  Show the whole range
                </Text>
              </Pressable>
            ) : (
              <Text tone="faint" variant="caption">
                Tap a column to read it.
              </Text>
            )}
          </>
        ) : (
          <Text align="center" style={styles.empty} tone="muted" variant="footnote">
            No model calls {shown === 'all' ? 'yet' : `in the last ${rangeLabel}`}.
          </Text>
        )}
      </View>
      {view.groups.length ? (
        <Group
          footer={
            split === 'place'
              ? undefined
              : `Tap a ${split === 'bot' ? 'bot' : 'model'} to see only its usage.`
          }
          title={split === 'bot' ? 'By bot' : split === 'model' ? 'By model' : 'Where it went'}
        >
          {view.groups.map(group => {
            const chosen =
              split === 'bot' ? bot === group.key : split === 'model' && model === group.key
            const shown = view.series.keys.includes(group.key) || view.series.keys.includes(OTHER)
            const { color, opacity } = slotColor(view.slots.get(group.key))
            const detail = [
              `${formatTokens(group.tokens)} tokens`,
              `${group.calls.toLocaleString()} ${group.calls === 1 ? 'call' : 'calls'}`,
              split === 'model' &&
                modelParts(group.key).provider &&
                providerName(modelParts(group.key).provider)
            ]
              .filter(Boolean)
              .join(' · ')
            const content = (
              <>
                <View style={[styles.dot, shown && { backgroundColor: color, opacity }]} />
                <View style={styles.rowBody}>
                  <Text numberOfLines={1} variant="body">
                    {name(split, group.key)}
                  </Text>
                  <Text numberOfLines={1} tone="muted" variant="footnote">
                    {detail}
                  </Text>
                </View>
                <View style={styles.rowValue}>
                  <Text style={styles.number} variant="footnote">
                    {metric === 'cost' ? formatCost(group.cost) : formatTokens(group.tokens)}
                  </Text>
                  <Text tone="muted" variant="caption">
                    {formatShare(group.share)}
                  </Text>
                </View>
                {split !== 'place' ? (
                  <Ionicons
                    color={chosen ? theme.accent : 'transparent'}
                    name="checkmark"
                    size={18}
                  />
                ) : null}
              </>
            )

            return split === 'place' ? (
              <View
                key={group.key}
                style={styles.row}
                testID={`usage-row-${group.key.replace('\u0000', ':')}`}
              >
                {content}
              </View>
            ) : (
              <Pressable
                accessibilityLabel={`${name(split, group.key)}, ${metric === 'cost' ? formatCost(group.cost) : `${formatTokens(group.tokens)} tokens`}, ${formatShare(group.share)}`}
                accessibilityRole="button"
                accessibilityState={{ selected: chosen }}
                key={group.key}
                onPress={() => filterBy(split, chosen ? null : group.key)}
                style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.pressed }]}
                testID={`usage-row-${group.key.replace('\u0000', ':')}`}
              >
                {content}
              </Pressable>
            )
          })}
        </Group>
      ) : null}
      {view.totals.tokens ? <TokenMix totals={view.totals} /> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, gap: 10, padding: 14 },
  cardHead: { alignItems: 'baseline', flexDirection: 'row', justifyContent: 'space-between' },
  chip: {
    alignItems: 'center',
    borderRadius: radius.pill,
    flexDirection: 'row',
    gap: 4,
    maxWidth: 220,
    paddingHorizontal: 12,
    paddingVertical: 6
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  dot: { borderRadius: 3, height: 10, width: 10 },
  empty: { paddingVertical: 40 },
  hero: { fontSize: 44, fontWeight: '700', letterSpacing: -0.5, lineHeight: 50 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, columnGap: 14 },
  legendLine: { alignItems: 'center', flexDirection: 'row', gap: 6 },
  legendText: { maxWidth: 200 },
  loading: { opacity: 0.6 },
  mix: { gap: 12, padding: 16 },
  mixBar: { flexDirection: 'row', gap: 2, height: 8 },
  mixItem: { gap: 2, width: '46%' },
  mixLegend: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 10, columnGap: 16 },
  mixPart: { borderRadius: 4, minWidth: 2 },
  number: { fontFamily: mono, fontVariant: ['tabular-nums'] },
  page: { gap: 20 },
  summary: { paddingHorizontal: 4 },
  placeholder: { height: 120 },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    minHeight: 56,
    paddingHorizontal: 16,
    paddingVertical: 8
  },
  rowBody: { flex: 1, minWidth: 0 },
  rowValue: { alignItems: 'flex-end' },
  swatch: { borderRadius: 2, height: 8, width: 8 },
  tile: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    gap: 2,
    minWidth: 0,
    padding: 10
  },
  tileValue: { fontVariant: ['tabular-nums'] },
  tiles: { flexDirection: 'row', gap: 8 }
})
