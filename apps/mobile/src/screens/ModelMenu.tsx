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

import { levelLabel, reasoningOptions, runningLevel } from '../core/reasoning'
import type { ModelOption, Rpc } from '../core/types'

type Group = { id: string; label: string; configured: boolean; models: ModelOption[] }
import { HIT, SearchField, Text, useTheme } from '../ui'

export { REASONING_LEVELS } from '../core/reasoning'

export interface ModelValue {
  provider: string
  model: string
  /** Empty means Pi's default, medium. */
  reasoning: string
}

/** Every model a provider lists right now, recommended ones first, as in the web app. */
async function providerModels(rpc: Rpc, provider: string) {
  const { all, curated, error } = await rpc<{
    curated: ModelOption[]
    all: ModelOption[]
    error?: string
  }>('hexbot.models.list', { provider })
  const listed = new Map(all.map(m => [m.id, m]))
  const recommended = new Set(curated.map(m => m.id))
  return {
    error,
    models: [
      ...curated.map(m => ({ ...listed.get(m.id), ...m })),
      ...all.filter(m => !recommended.has(m.id))
    ]
  }
}

/** The bot's own model, from its provider's list. */
function useCurrentModel(rpc: Rpc, value: ModelValue) {
  const [loaded, setLoaded] = useState<{ provider: string; models: ModelOption[] } | null>(null)
  useEffect(() => {
    if (!value.provider) return
    let live = true
    providerModels(rpc, value.provider)
      .then(({ models }) => live && setLoaded({ provider: value.provider, models }))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [rpc, value.provider])
  return loaded?.provider === value.provider
    ? loaded.models.find(m => m.id === value.model)
    : undefined
}

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
  const current = useCurrentModel(rpc, value)
  // The level the model runs at, which may differ from the one saved.
  const running = runningLevel(value.reasoning || 'medium', current)
  const level = (current || value.reasoning) && running !== 'off' ? levelLabel(running) : null

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
  const [groups, setGroups] = useState<Group[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const visible = !!anchor

  // Only providers with a key or sign-in, plus the bot's own so it reads correctly.
  useEffect(() => {
    if (!visible) return
    let live = true
    setError(null)
    setQuery('')
    setGroups(null)
    void (async () => {
      const { providers } = await rpc<{
        providers: { id: string; label: string; configured: boolean }[]
      }>('hexbot.providers.list')
      const shown = providers
        .filter(p => p.configured || p.id === value.provider)
        .sort(
          (a, b) =>
            Number(b.id === value.provider) - Number(a.id === value.provider) ||
            a.label.localeCompare(b.label)
        )
      const errors: string[] = []
      const loaded = await Promise.all(
        shown.map(async provider => {
          let models: ModelOption[] = []
          try {
            const result = await providerModels(rpc, provider.id)
            models = result.models
            if (result.error) errors.push(`${provider.label}: ${result.error}`)
          } catch (e) {
            errors.push(`${provider.label}: ${e instanceof Error ? e.message : String(e)}`)
          }
          // The bot's own model stays visible even when the provider's list leaves it out.
          if (
            provider.id === value.provider &&
            value.model &&
            !models.some(m => m.id === value.model)
          )
            models = [...models, { id: value.model, label: value.model, provider: provider.id }]
          return { ...provider, models }
        })
      )
      if (!live) return
      setGroups(loaded)
      if (errors.length) setError(errors.join('\n'))
    })().catch(e => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
    // Load once per opening; picking a model while open keeps the list.
  }, [rpc, visible])

  const current = groups?.find(g => g.id === value.provider)?.models.find(m => m.id === value.model)
  const options = reasoningOptions(current)
  const withoutThinking = options.length === 1 && options[0].value === 'off'
  const running = runningLevel(value.reasoning || 'medium', current)
  const total = groups?.reduce((n, g) => n + g.models.length, 0) ?? 0
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (groups ?? [])
      .map(group => ({
        ...group,
        models: group.models.filter(
          row => !needle || `${row.label} ${row.id} ${group.label}`.toLowerCase().includes(needle)
        )
      }))
      .filter(group => group.models.length)
  }, [groups, query])

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
            {groups === null && !error ? (
              <ActivityIndicator />
            ) : withoutThinking ? (
              <Text tone="muted" variant="footnote" testID={`${testID}-no-thinking`}>
                {value.model} answers without a thinking step.
              </Text>
            ) : (
              <>
                <View style={styles.levels}>
                  {options.map(level => {
                    const selected = running === level.value
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
          {total > 8 ? (
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
            {filtered.map(group => (
              <View key={group.id}>
                <Text style={styles.provider} tone="muted" variant="caption">
                  {group.label}
                  {group.configured ? '' : ', not connected'}
                </Text>
                {group.models.map(row => {
                  const selected = row.id === value.model && group.id === value.provider
                  return (
                    <Pressable
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected }}
                      key={row.id}
                      onPress={() => onChange({ model: row.id, provider: group.id })}
                      style={({ pressed }) => [
                        styles.model,
                        { backgroundColor: pressed ? theme.pressed : 'transparent' }
                      ]}
                      testID={`${testID}-model-${group.id}-${row.id}`}
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
