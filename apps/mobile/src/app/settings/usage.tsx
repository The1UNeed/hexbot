import { Stack } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { RefreshControl, StyleSheet, Text, View } from 'react-native'

import { BotFace } from '../../components/face'
import { Group, ListScroll } from '../../components/list'
import { Cell, errorText, PageState, useOnReconnect } from '../../components/settings/kit'
import { rpcCall } from '../../lib/rpc'
import type { UsageSummary } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useTheme } from '../../theme'

interface BotUsage {
  bot: string
  cost: number
  input: number
  output: number
}

/** Seconds since the epoch at local midnight: "today" on this phone. */
function startOfToday(): number {
  const date = new Date()
  date.setHours(0, 0, 0, 0)

  return Math.floor(date.getTime() / 1000)
}

export const cost = (value: number) => (value > 0 && value < 0.01 ? '<$0.01' : `$${value.toFixed(2)}`)

/** 980, 12,400, 1.2M: exact while it is short, rounded once it is not. */
export function tokens(value: number): string {
  if (value < 100_000) {
    return value.toLocaleString()
  }

  if (value < 1_000_000) {
    return `${Math.round(value / 1000)}K`
  }

  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`
}

function rowsOf(summary: UsageSummary): BotUsage[] {
  const raw = Array.isArray(summary.by_bot) ? summary.by_bot : Object.entries(summary.by_bot).map(([bot, value]) => ({ bot, ...value }))

  return raw
    .map(row => ({ bot: row.bot, cost: row.estimated_cost_usd ?? 0, input: row.input_tokens, output: row.output_tokens }))
    .filter(row => row.input + row.output > 0)
    .sort((a, b) => b.cost - a.cost || b.input + b.output - (a.input + a.output))
}

/** Usage today: the estimated cost large, tokens under it, then each bot. */
export default function Usage() {
  const { colors } = useTheme()
  const bots = useBots(state => state.byName)
  const [summary, setSummary] = useState<null | UsageSummary>(null)
  const [error, setError] = useState<null | string>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    setError(null)

    try {
      setSummary(await rpcCall<UsageSummary>('hexbot.usage.summary', { since: startOfToday() }))
    } catch (caught) {
      setError(errorText(caught))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])
  useOnReconnect(load)

  const rows = summary ? rowsOf(summary) : []

  return (
    <>
      <Stack.Screen options={{ title: 'Usage' }} />
      <ListScroll
        refreshControl={
          <RefreshControl
            onRefresh={() => {
              setRefreshing(true)
              void load().finally(() => setRefreshing(false))
            }}
            refreshing={refreshing}
          />
        }
        testID="usage"
      >
        {!summary ? (
          <PageState error={error} onRetry={() => void load()} />
        ) : (
          <>
            <View style={styles.hero}>
              <Text style={[styles.heroLabel, { color: colors.textMuted }]}>Today</Text>
              <Text accessibilityLabel={`Estimated cost ${cost(summary.estimated_cost_usd)}`} style={[styles.heroCost, { color: colors.text }]}>
                {cost(summary.estimated_cost_usd)}
              </Text>
              <View style={styles.stats}>
                <Stat label="Input tokens" value={tokens(summary.input_tokens)} />
                <View style={[styles.rule, { backgroundColor: colors.hairline }]} />
                <Stat label="Output tokens" value={tokens(summary.output_tokens)} />
              </View>
            </View>

            <Group
              footer={
                rows.length
                  ? 'Estimated from each provider’s list prices, since midnight on this phone.'
                  : 'No bot has used a model today. Pull down to refresh.'
              }
              label="By bot"
            >
              {rows.map(row => (
                <Cell key={row.bot} style={styles.botRow} testID={`usage-${row.bot}`}>
                  <BotFace bot={bots[row.bot]} name={row.bot} size={32} />
                  <View style={styles.botBody}>
                    <Text numberOfLines={1} style={[styles.botName, { color: colors.text }]}>
                      {bots[row.bot]?.display_name ?? row.bot}
                    </Text>
                    <Text numberOfLines={1} style={[styles.botTokens, { color: colors.textMuted }]}>
                      {tokens(row.input)} in · {tokens(row.output)} out
                    </Text>
                  </View>
                  <Text style={[styles.botCost, { color: colors.text }]}>{cost(row.cost)}</Text>
                </Cell>
              ))}
            </Group>
          </>
        )}
      </ListScroll>
    </>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme()

  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, { color: colors.text }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: colors.textMuted }]}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  botBody: { flex: 1, gap: 2, minWidth: 0 },
  botCost: { fontSize: 17, fontVariant: ['tabular-nums'] },
  botName: { fontSize: 17, lineHeight: 22 },
  botRow: { paddingVertical: 10 },
  botTokens: { fontSize: 14, fontVariant: ['tabular-nums'] },
  hero: { alignItems: 'center', paddingBottom: 4, paddingTop: 12 },
  heroCost: { fontSize: 56, fontVariant: ['tabular-nums'], fontWeight: '600', letterSpacing: -1, lineHeight: 64 },
  heroLabel: { fontSize: 15, fontWeight: '500' },
  rule: { alignSelf: 'stretch', width: StyleSheet.hairlineWidth },
  stat: { alignItems: 'center', flex: 1, gap: 2 },
  statLabel: { fontSize: 13 },
  statValue: { fontSize: 22, fontVariant: ['tabular-nums'], fontWeight: '600' },
  stats: { flexDirection: 'row', marginTop: 20, paddingHorizontal: 12 }
})
