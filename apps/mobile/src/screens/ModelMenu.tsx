import { Ionicons } from '@expo/vector-icons'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import type { ModelOption, Rpc } from '../core/types'
import { HIT, SearchField, Text, useTheme } from '../ui'

/** Labels for Pi's levels. The daemon supplies each model's available choices. */
export const REASONING_LEVELS = [
  { label: 'Off', value: 'off' },
  { label: 'Minimal', value: 'minimal' },
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'Extra high', value: 'xhigh' },
  { label: 'Max', value: 'max' }
] as const

export interface ModelValue {
  provider: string
  model: string
  /** Empty means Pi's default, medium. */
  reasoning: string
}

type Row = ModelOption & { reasoning_levels?: string[] }

const levelLabel = (value: string) => REASONING_LEVELS.find(l => l.value === value)?.label

/**
 * The bot's model as a small pill. Tapping it opens a compact menu with the
 * thinking levels the daemon says the model supports and the other models.
 */
export function ModelPill({
  disabled,
  onChange,
  rpc,
  testID,
  value
}: {
  value: ModelValue
  onChange: (next: Partial<ModelValue>) => void
  rpc: Rpc
  testID: string
  disabled?: boolean
}) {
  const theme = useTheme()
  const anchor = useRef<View>(null)
  const [frame, setFrame] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const level = value.reasoning ? levelLabel(value.reasoning) : null

  const open = () => anchor.current?.measureInWindow((x, y, w, h) => setFrame({ h, w, x, y }))

  return (
    <>
      <Pressable
        accessibilityHint="Choose the model and how hard it thinks"
        accessibilityLabel={`Model ${value.model || 'not set'}${level ? `, thinking ${level}` : ''}`}
        accessibilityRole="button"
        disabled={disabled}
        onPress={open}
        ref={anchor}
        style={({ pressed }) => [{ opacity: disabled ? 0.45 : pressed ? 0.6 : 1 }]}
        testID={testID}
      >
        <View style={[styles.pill, { backgroundColor: theme.fill }]}>
          <Ionicons color={theme.muted} name="sparkles-outline" size={15} />
          <Text numberOfLines={1} style={styles.pillText} variant="subhead">
            {value.model || 'Choose a model'}
          </Text>
          {level ? (
            <Text tone="muted" variant="footnote">
              {level}
            </Text>
          ) : null}
          <Ionicons color={theme.muted} name="chevron-expand" size={14} />
        </View>
      </Pressable>
      <ModelMenu
        anchor={frame}
        onChange={onChange}
        onClose={() => setFrame(null)}
        rpc={rpc}
        testID={`${testID}-menu`}
        value={value}
      />
    </>
  )
}

function ModelMenu({
  anchor,
  onChange,
  onClose,
  rpc,
  testID,
  value
}: {
  anchor: { x: number; y: number; w: number; h: number } | null
  value: ModelValue
  onChange: (next: Partial<ModelValue>) => void
  onClose: () => void
  rpc: Rpc
  testID: string
}) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const window = useWindowDimensions()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [providers, setProviders] = useState<
    Record<string, { label: string; configured: boolean }>
  >({})
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const visible = !!anchor

  useEffect(() => {
    if (!visible) return
    let live = true
    setError(null)
    setQuery('')
    rpc<{ providers: { id: string; label: string; configured: boolean }[] }>(
      'hexbot.providers.list'
    )
      .then(result => {
        if (live)
          setProviders(
            Object.fromEntries(
              result.providers.map(p => [p.id, { label: p.label, configured: p.configured }])
            )
          )
      })
      .catch(() => {})
    rpc<{ curated: Row[]; all: Row[]; error?: string }>('hexbot.models.list')
      .then(result => {
        if (!live) return
        const merged = new Map<string, Row>()
        for (const row of [...result.curated, ...result.all]) {
          const key = `${row.provider}/${row.id}`
          merged.set(key, { ...merged.get(key), ...row })
        }
        setRows([...merged.values()])
        if (result.error) setError(result.error)
      })
      .catch(e => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [rpc, visible])

  const current =
    rows?.find(r => r.id === value.model && r.provider === value.provider) ??
    rows?.find(r => r.id === value.model)
  const withoutThinking =
    current?.reasoning_levels?.length === 1 && current.reasoning_levels[0] === 'off'
  const levels = REASONING_LEVELS.filter(level => current?.reasoning_levels?.includes(level.value))
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const map = new Map<string, Row[]>()
    for (const row of rows ?? []) {
      if (needle && !`${row.label} ${row.id} ${row.provider}`.toLowerCase().includes(needle))
        continue
      const key = row.provider ?? ''
      map.set(key, [...(map.get(key) ?? []), row])
    }
    // The bot's own provider first, then the ones with credentials.
    const rank = (id: string) => (id === value.provider ? 0 : providers[id]?.configured ? 1 : 2)
    return [...map.entries()].sort(
      ([a], [b]) =>
        rank(a) - rank(b) || (providers[a]?.label ?? a).localeCompare(providers[b]?.label ?? b)
    )
  }, [providers, query, rows, value.provider])

  if (!anchor) return null

  const width = Math.min(344, window.width - 24)
  const left = Math.min(Math.max(12, anchor.x), window.width - width - 12)
  const below = window.height - (anchor.y + anchor.h) - insets.bottom - 20
  const above = anchor.y - insets.top - 20
  const downward = below >= 320 || below >= above
  const maxHeight = Math.min(480, downward ? below : above)
  const place = downward
    ? { top: anchor.y + anchor.h + 8 }
    : { bottom: window.height - anchor.y + 8 }

  return (
    <Modal animationType="fade" onRequestClose={onClose} statusBarTranslucent transparent visible>
      <Pressable
        accessibilityLabel="Close menu"
        onPress={onClose}
        style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.12)' }]}
        testID={`${testID}-backdrop`}
      />
      <View style={[styles.menu, place, { left, maxHeight, width }]} testID={testID}>
        <View
          style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.chromeBorder }]}
        >
          <View style={styles.section}>
            <Text tone="muted" variant="footnote">
              Thinking
            </Text>
            {rows === null && !error ? (
              <ActivityIndicator />
            ) : withoutThinking ? (
              <Text tone="muted" variant="footnote" testID={`${testID}-no-thinking`}>
                {value.model} answers without a thinking step.
              </Text>
            ) : levels.length === 0 ? (
              <Text tone="muted" variant="footnote" testID={`${testID}-unknown-thinking`}>
                Thinking options aren't available for this model.
              </Text>
            ) : (
              <>
                <View style={styles.levels}>
                  {levels.map(level => {
                    const selected = (value.reasoning || 'medium') === level.value
                    return (
                      <Pressable
                        accessibilityRole="radio"
                        accessibilityState={{ checked: selected }}
                        key={level.value}
                        onPress={() => onChange({ reasoning: level.value })}
                        style={({ pressed }) => [
                          styles.level,
                          {
                            backgroundColor: selected ? theme.ink : theme.fill,
                            opacity: pressed ? 0.7 : 1
                          }
                        ]}
                        testID={`${testID}-level-${level.value}`}
                      >
                        <Text
                          maxFontSizeMultiplier={1.3}
                          style={{ color: selected ? theme.onInk : theme.text }}
                          variant="footnote"
                        >
                          {level.label}
                        </Text>
                      </Pressable>
                    )
                  })}
                </View>
              </>
            )}
          </View>
          <View style={[styles.rule, { backgroundColor: theme.hairline }]} />
          {(rows?.length ?? 0) > 8 ? (
            <View style={styles.search}>
              <SearchField
                onChangeText={setQuery}
                placeholder="Search models"
                testID={`${testID}-search`}
                value={query}
              />
            </View>
          ) : null}
          {error ? (
            <Text style={styles.note} tone="danger" variant="footnote">
              {error}
            </Text>
          ) : null}
          <ScrollView keyboardShouldPersistTaps="handled" style={styles.list}>
            {groups.map(([provider, models]) => (
              <View key={provider}>
                <Text style={styles.provider} tone="muted" variant="caption">
                  {providers[provider]?.label ?? (provider || 'Other')}
                  {providers[provider] && !providers[provider].configured ? ', not connected' : ''}
                </Text>
                {models.map(row => {
                  const selected = row.id === value.model && row.provider === value.provider
                  return (
                    <Pressable
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected }}
                      key={`${row.provider}/${row.id}`}
                      onPress={() => onChange({ model: row.id, provider: row.provider ?? '' })}
                      style={({ pressed }) => [
                        styles.model,
                        { backgroundColor: pressed ? theme.pressed : 'transparent' }
                      ]}
                      testID={`${testID}-model-${row.provider}-${row.id}`}
                    >
                      <View style={styles.modelText}>
                        <Text numberOfLines={1} variant="callout">
                          {row.label || row.id}
                        </Text>
                        {row.label && row.label !== row.id ? (
                          <Text numberOfLines={1} tone="muted" variant="caption">
                            {row.id}
                          </Text>
                        ) : null}
                      </View>
                      {selected ? (
                        <Ionicons color={theme.accent} name="checkmark" size={20} />
                      ) : null}
                    </Pressable>
                  )
                })}
              </View>
            ))}
          </ScrollView>
          <Text style={styles.note} tone="muted" variant="caption">
            Threads using this bot's default follow changes when idle.
          </Text>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    flexShrink: 1,
    overflow: 'hidden'
  },
  level: {
    alignItems: 'center',
    borderRadius: 999,
    justifyContent: 'center',
    minHeight: HIT,
    paddingHorizontal: 12
  },
  levels: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  list: { flexGrow: 0, flexShrink: 1 },
  menu: {
    elevation: 16,
    position: 'absolute',
    shadowColor: '#000',
    shadowOffset: { height: 10, width: 0 },
    shadowOpacity: 0.2,
    shadowRadius: 28
  },
  model: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    minHeight: HIT,
    paddingHorizontal: 16,
    paddingVertical: 6
  },
  modelText: { flex: 1, minWidth: 0 },
  note: { paddingBottom: 12, paddingHorizontal: 16, paddingTop: 8 },
  pill: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 6,
    maxWidth: 300,
    minHeight: HIT,
    paddingHorizontal: 14
  },
  pillText: { flexShrink: 1 },
  provider: { paddingBottom: 2, paddingHorizontal: 16, paddingTop: 10 },
  rule: { height: StyleSheet.hairlineWidth },
  search: { paddingHorizontal: 12, paddingTop: 10 },
  section: { gap: 8, padding: 14 }
})
