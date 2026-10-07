import { useLocalSearchParams } from 'expo-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native'

import { connectorGlyph } from '../../../components/bot/connector-fields'
import { openPage } from '../../../components/bot/nav'
import { BotPage, Note } from '../../../components/bot/page'
import { errorText } from '../../../components/bot/use-bot'
import { Button } from '../../../components/button'
import { Icon } from '../../../components/icon'
import { Group } from '../../../components/list'
import { connectorsTest } from '../../../lib/api'
import type { Bot, Connector, ConnectorGroup } from '../../../lib/types'
import { useConnectors, useConnectorsForBot } from '../../../stores/connectors'
import { type Palette, useTheme } from '../../../theme'

const GROUPS: { id: ConnectorGroup; title: string }[] = [
  { id: 'search', title: 'Search and browsing' },
  { id: 'media', title: 'Images and voice' },
  { id: 'work', title: 'Notes and work' },
  { id: 'social_home', title: 'Social and home' },
  { id: 'mcp', title: 'Connected tools' }
]

type Filter = 'all' | 'needs_setup' | 'on'

export default function Connectors() {
  return (
    <BotPage lead="Services this bot can reach. Keys are stored once on the daemon and shared by every bot." title="Connectors">
      {({ bot }) => <ConnectorList bot={bot} />}
    </BotPage>
  )
}

function ConnectorList({ bot }: { bot: Bot }) {
  const { colors } = useTheme()
  const connectors = useConnectorsForBot(bot.name)
  const loading = useConnectors(state => state.loading)
  const storeError = useConnectors(state => state.error)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [expanded, setExpanded] = useState<null | string>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<null | string>(null)

  useEffect(() => {
    void useConnectors.getState().refresh(bot.name)
  }, [bot.name])

  // `?connector=<id>` opens that connector's set-up sheet, which is how a "Fix" action in a chat lands here.
  const { connector: wanted } = useLocalSearchParams<{ connector?: string }>()
  const opened = useRef(false)

  useEffect(() => {
    if (wanted && !opened.current && connectors.some(item => item.id === wanted)) {
      opened.current = true
      openPage(bot.name, 'setup', { id: wanted })
    }
  }, [bot.name, connectors, wanted])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()

    return connectors.filter(item => {
      if (needle && !`${item.name} ${item.description}`.toLowerCase().includes(needle)) {
        return false
      }

      return filter === 'on' ? Boolean(item.enabled_for_bot) : filter === 'needs_setup' ? item.state !== 'ready' : true
    })
  }, [connectors, filter, query])

  const act = (work: Promise<unknown>) => {
    setError(null)
    void work.catch(caught => setError(errorText(caught)))
  }

  const filters: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'on', label: `On for ${bot.display_name}` },
    { id: 'needs_setup', label: 'Needs setup' }
  ]

  return (
    <>
      <View style={{ gap: 12 }}>
        <View style={[styles.search, { backgroundColor: colors.bubbleBot }]}>
          <Icon color={colors.textMuted} name="magnifyingglass" size={16} />
          <TextInput
            accessibilityLabel="Search connectors"
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            onChangeText={setQuery}
            placeholder="Search connectors"
            placeholderTextColor={colors.textFaint}
            style={[styles.searchField, { color: colors.text }]}
            testID="connectors-search"
            value={query}
          />
        </View>
        <ScrollView contentContainerStyle={styles.chips} horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
          {filters.map(item => {
            const on = filter === item.id

            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                key={item.id}
                onPress={() => setFilter(item.id)}
                style={[styles.chip, { backgroundColor: on ? colors.primary : colors.bubbleBot }]}
                testID={`connectors-filter-${item.id}`}
              >
                <Text numberOfLines={1} style={[styles.chipText, { color: on ? colors.primaryText : colors.text }]}>
                  {item.label}
                </Text>
              </Pressable>
            )
          })}
        </ScrollView>
      </View>

      {storeError && !connectors.length ? <Note danger text={storeError} /> : null}
      {error ? <Note danger text={error} /> : null}
      {loading && !connectors.length ? <ActivityIndicator color={colors.textMuted} style={{ paddingVertical: 24 }} /> : null}
      {!loading && connectors.length && !visible.length ? <Note text="Nothing matches." /> : null}

      {GROUPS.map(group => {
        const rows = visible.filter(item => item.group === group.id)
        const showAdd = group.id === 'mcp' && filter === 'all' && !query

        if (!rows.length && !showAdd) {
          return null
        }

        return (
          <Group key={group.id} label={group.title}>
            {rows.map(item => (
              <ConnectorRow
                bot={bot}
                colors={colors}
                connector={item}
                expanded={expanded === item.id}
                key={item.id}
                onClear={() => act(useConnectors.getState().clear(bot.name, item.id))}
                onExpand={() => setExpanded(expanded === item.id ? null : item.id)}
                onRemove={
                  item.group === 'mcp'
                    ? () =>
                        Alert.alert(`Remove ${item.name}?`, 'It goes away for every bot.', [
                          { style: 'cancel', text: 'Cancel' },
                          {
                            onPress: () => act(useConnectors.getState().removeMcp(bot.name, item.id.replace(/^mcp:/, ''))),
                            style: 'destructive',
                            text: 'Remove'
                          }
                        ])
                    : undefined
                }
                onSetup={() => openPage(bot.name, 'setup', { id: item.id })}
                onToggle={on => act(useConnectors.getState().setForBot(bot.name, item.id, on))}
              />
            ))}
            {showAdd ? (
              adding ? (
                <AddServer bot={bot} key="add-form" onDone={() => setAdding(false)} />
              ) : (
                <Pressable
                  accessibilityRole="button"
                  key="add"
                  onPress={() => setAdding(true)}
                  style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface3 }]}
                  testID="connectors-add-mcp"
                >
                  <View style={[styles.tile, { backgroundColor: colors.surface3 }]}>
                    <Icon color={colors.text} name="plus" size={15} weight="semibold" />
                  </View>
                  <Text style={[styles.name, { color: colors.text }]}>Add MCP server</Text>
                </Pressable>
              )
            ) : null}
          </Group>
        )
      })}
    </>
  )
}

function ConnectorRow({
  bot,
  colors,
  connector,
  expanded,
  onClear,
  onExpand,
  onRemove,
  onSetup,
  onToggle
}: {
  bot: Bot
  colors: Palette
  connector: Connector
  expanded: boolean
  onClear: () => void
  onExpand: () => void
  onRemove?: () => void
  onSetup: () => void
  onToggle: (on: boolean) => void
}) {
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState<null | string>(null)
  const failed = connector.state === 'error'
  const needsSetup = !connector.mcp && connector.state === 'not_set_up'

  const control =
    !connector.mcp && failed ? (
      <SmallButton colors={colors} label="Fix" onPress={onSetup} primary testID={`connector-fix-${connector.id}`} />
    ) : needsSetup ? (
      <SmallButton colors={colors} label="Set up" onPress={onSetup} testID={`connector-setup-${connector.id}`} />
    ) : (
      <View style={Platform.OS === 'ios' ? styles.switchBox : undefined}>
        <Switch
          accessibilityLabel={`${connector.name} for ${bot.display_name}`}
          onValueChange={onToggle}
          testID={`connector-switch-${connector.id}`}
          trackColor={{ false: colors.surface3, true: colors.success }}
          value={Boolean(connector.enabled_for_bot)}
        />
      </View>
    )

  return (
    <View testID={`connector-${connector.id}`}>
      <View style={styles.rowWrap}>
        <Pressable
          accessibilityHint={expanded ? 'Hides the details' : 'Shows the details'}
          accessibilityLabel={`${connector.name}, ${connector.state_text}`}
          accessibilityRole="button"
          onPress={onExpand}
          style={({ pressed }) => [styles.row, styles.rowMain, pressed && { backgroundColor: colors.surface3 }]}
        >
          <View style={[styles.tile, { backgroundColor: colors.surface3 }]}>
            <Icon color={colors.text} name={connectorGlyph(connector.icon)} size={15} />
          </View>
          <View style={styles.body}>
            <View style={styles.titleLine}>
              <Text numberOfLines={1} style={[styles.name, { color: colors.text }]}>
                {connector.name}
              </Text>
              <Text numberOfLines={1} style={[styles.state, { color: failed ? colors.danger : colors.textMuted }]}>
                {connector.state_text}
              </Text>
            </View>
            <Text numberOfLines={expanded ? undefined : 1} style={[styles.description, { color: colors.textMuted }]}>
              {connector.description}
            </Text>
          </View>
        </Pressable>
        <View style={styles.control}>{control}</View>
      </View>
      {expanded ? (
        <View style={styles.details}>
          {connector.fields.map(field => (
            <View key={field.key} style={styles.field}>
              <Text style={[styles.detail, { color: colors.textMuted }]}>{field.label}</Text>
              <Text style={[styles.detail, { color: colors.text }]}>{field.set ? (field.hint ? `Saved ${field.hint}` : 'Saved') : 'Not set'}</Text>
            </View>
          ))}
          {connector.mcp ? (
            <Text style={[styles.detail, { color: colors.textMuted }]}>
              {connector.mcp.test_failed ? 'Test failed' : connector.mcp.tool_count === null ? 'Not tested' : `${connector.mcp.tool_count} tools`} ·{' '}
              {connector.mcp.transport} · {connector.mcp.running ? 'running' : 'not running'}
            </Text>
          ) : null}
          {connector.last_error ? <Text style={[styles.detail, { color: colors.danger }]}>{connector.last_error.text}</Text> : null}
          {testError ? <Text style={[styles.detail, { color: colors.danger }]}>{testError}</Text> : null}
          <View style={styles.detailActions}>
            {connector.mcp ? (
              <SmallButton
                colors={colors}
                label={testing ? 'Testing' : 'Test'}
                onPress={() => {
                  setTesting(true)
                  setTestError(null)
                  void connectorsTest(connector.id, bot.name)
                    .then(() => useConnectors.getState().refresh(bot.name))
                    .catch(caught => setTestError(errorText(caught)))
                    .finally(() => setTesting(false))
                }}
              />
            ) : null}
            {connector.fields.length ? <SmallButton colors={colors} label={needsSetup ? 'Set up' : 'Edit'} onPress={onSetup} /> : null}
            {connector.state !== 'not_set_up' && connector.fields.length ? <SmallButton colors={colors} label="Remove values" onPress={onClear} plain /> : null}
            {onRemove ? <SmallButton colors={colors} label="Remove server" onPress={onRemove} plain /> : null}
          </View>
        </View>
      ) : null}
    </View>
  )
}

function SmallButton({
  colors,
  label,
  onPress,
  plain,
  primary,
  testID
}: {
  colors: Palette
  label: string
  onPress: () => void
  plain?: boolean
  primary?: boolean
  testID?: string
}) {
  return (
    <Pressable
      accessibilityRole="button"
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [
        styles.small,
        { backgroundColor: primary ? colors.primary : plain ? 'transparent' : colors.surface3, opacity: pressed ? 0.7 : 1 },
        plain && { paddingHorizontal: 6 }
      ]}
      testID={testID}
    >
      <Text style={[styles.smallText, { color: primary ? colors.primaryText : plain ? colors.textMuted : colors.text }]}>{label}</Text>
    </Pressable>
  )
}

function AddServer({ bot, onDone }: { bot: Bot; onDone: () => void }) {
  const { colors } = useTheme()
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)
  const isUrl = /^https?:\/\//i.test(target.trim())

  const add = async () => {
    setBusy(true)
    setError(null)
    const parts = target.trim().split(/\s+/)

    try {
      await useConnectors.getState().addMcp(bot.name, {
        name: name.trim(),
        ...(isUrl ? { transport: 'http' as const, url: target.trim() } : { args: parts.slice(1), command: parts[0] ?? '' })
      })
      onDone()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  const input = [styles.input, { backgroundColor: colors.bg, color: colors.text }]

  return (
    <View style={styles.form}>
      <TextInput
        accessibilityLabel="Server name"
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
        onChangeText={setName}
        placeholder="Name, like github"
        placeholderTextColor={colors.textFaint}
        style={input}
        value={name}
      />
      <TextInput
        accessibilityLabel="Command or URL"
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setTarget}
        placeholder="Command or URL"
        placeholderTextColor={colors.textFaint}
        style={input}
        value={target}
      />
      {error ? <Text style={[styles.detail, { color: colors.danger }]}>{error}</Text> : null}
      <View style={styles.formButtons}>
        <Button onPress={onDone} style={styles.formButton} variant="secondary">
          Cancel
        </Button>
        <Button disabled={!name.trim() || !target.trim()} loading={busy} onPress={() => void add()} style={styles.formButton}>
          Add server
        </Button>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  body: { flex: 1, gap: 2, minWidth: 0 },
  chip: { borderRadius: 999, height: 34, justifyContent: 'center', paddingHorizontal: 14 },
  chipRow: { marginHorizontal: -16 },
  chipText: { fontSize: 15, fontWeight: '500' },
  chips: { gap: 8, paddingHorizontal: 16 },
  description: { fontSize: 14, lineHeight: 19 },
  detail: { fontSize: 14, lineHeight: 19 },
  detailActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 4 },
  details: { gap: 6, paddingBottom: 14, paddingLeft: 58, paddingRight: 16 },
  field: { flexDirection: 'row', gap: 12, justifyContent: 'space-between' },
  form: { gap: 10, padding: 16 },
  formButton: { flex: 1, height: 46 },
  formButtons: { flexDirection: 'row', gap: 10 },
  input: { borderRadius: 12, fontSize: 16, height: 44, paddingHorizontal: 14 },
  name: { flexShrink: 1, fontSize: 17 },
  control: { paddingRight: 16 },
  row: { alignItems: 'center', flexDirection: 'row', gap: 14, minHeight: 60, paddingHorizontal: 16, paddingVertical: 10 },
  rowMain: { flex: 1, paddingRight: 12 },
  rowWrap: { alignItems: 'center', flexDirection: 'row' },
  search: { alignItems: 'center', borderRadius: 999, flexDirection: 'row', gap: 8, height: 44, paddingHorizontal: 14 },
  searchField: { flex: 1, fontSize: 17, height: 44 },
  small: { alignItems: 'center', borderRadius: 999, height: 32, justifyContent: 'center', paddingHorizontal: 14 },
  smallText: { fontSize: 15, fontWeight: '600' },
  state: { flexShrink: 1, fontSize: 13 },
  switchBox: { height: 28, width: 63 },
  tile: { alignItems: 'center', borderCurve: 'continuous', borderRadius: 8, height: 28, justifyContent: 'center', width: 28 },
  titleLine: { alignItems: 'baseline', flexDirection: 'row', gap: 8 }
})
