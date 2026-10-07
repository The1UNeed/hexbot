import { router } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'

import { useBotSheet } from '../../../components/bot/nav'
import { BotPage, Note } from '../../../components/bot/page'
import { errorText } from '../../../components/bot/use-bot'
import { Button } from '../../../components/button'
import { Group, Row, SwitchRow } from '../../../components/list'
import { botMemoryGet, botMemorySet, type Dream, dreamingList, dreamingRestore, dreamingRunNow, dreamingStatus, type DreamStatus } from '../../../lib/api'
import { toMillis } from '../../../lib/time'
import type { Bot, BotUpdatePatch } from '../../../lib/types'
import { sectionsActions } from '../../../stores/sections'
import { useSettings } from '../../../stores/settings'
import { useTheme } from '../../../theme'

/** A dream's summary as one plain line: the log is not the place for headings and bold. */
const plain = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+(.+?)[.:]?\s*$/gm, '$1.')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()

const DREAM_STATUS: Record<string, string> = { complete: 'Done', failed: 'Failed', running: 'Dreaming now' }

/** The daemon sends epoch seconds or an ISO string, depending on the field. */
const when = (value: null | number | string | undefined) => {
  const ms = typeof value === 'string' ? Date.parse(value) : toMillis(value)

  return ms ? new Date(ms).toLocaleString([], { day: 'numeric', hour: 'numeric', minute: '2-digit', month: 'short' }) : 'Never'
}

export default function Memory() {
  return (
    <BotPage lead="What this bot has learned. It writes here on its own; dreaming tidies it up each day." title="Memory">
      {({ bot, quietly }) => <MemoryBody bot={bot} save={quietly} />}
    </BotPage>
  )
}

function MemoryBody({ bot, save }: { bot: Bot; save: (patch: BotUpdatePatch) => void }) {
  const sheet = useBotSheet()
  const [memory, setMemory] = useState<null | { cap: number; memory_md: string }>(null)
  const [error, setError] = useState<null | string>(null)

  useEffect(() => {
    void botMemoryGet(bot.name)
      .then(setMemory)
      .catch(caught => setError(errorText(caught)))
  }, [bot.name])

  return (
    <>
      {memory ? (
        <MemoryEditor
          cap={memory.cap}
          onSave={async text => setMemory(await botMemorySet(bot.name, text))}
          placeholder="Nothing yet. The bot writes here as it learns."
          value={memory.memory_md}
        />
      ) : error ? (
        <Note danger text={error} />
      ) : (
        <Group label="This bot's memory">
          <Row loading title="Loading" />
        </Group>
      )}
      <Group>
        <Row
          chevron
          onPress={() => {
            sheet.close()
            router.push('/settings/about-you')
          }}
          subtitle="Written by you and read by every bot you own."
          testID="memory-about-you"
          title="About you"
        />
      </Group>
      <Dreaming bot={bot} onRestored={text => setMemory(current => current && { ...current, memory_md: text })} save={save} />
    </>
  )
}

/** One capped text in a card; saves when the field loses focus or the page closes. */
function MemoryEditor({
  cap,
  onSave,
  placeholder,
  value
}: {
  cap: number
  onSave: (text: string) => Promise<void>
  placeholder: string
  value: string
}) {
  const { colors } = useTheme()
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState<null | string>(null)
  const [saving, setSaving] = useState(false)
  const latest = useRef({ draft, saved: value })
  const tooLong = draft.length > cap

  latest.current.draft = draft

  useEffect(() => {
    latest.current.saved = value
    setDraft(value)
  }, [value])

  const commit = async () => {
    if (draft === latest.current.saved) {
      return
    }

    if (draft.length > cap) {
      return setError(`Keep this to ${cap.toLocaleString()} characters or fewer.`)
    }

    setSaving(true)
    setError(null)

    try {
      await onSave(draft)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setSaving(false)
    }
  }

  useEffect(
    () => () => {
      const { draft: text, saved } = latest.current

      if (text !== saved && text.length <= cap) {
        void onSave(text).catch(() => undefined)
      }
    },
    // Only on leaving the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  return (
    <Group
      error={error}
      footer={
        <View style={styles.counter}>
          <Text style={{ color: tooLong ? colors.danger : colors.textMuted, fontSize: 13 }}>
            {draft.length.toLocaleString()} of {cap.toLocaleString()} characters
          </Text>
          {saving ? <ActivityIndicator color={colors.textMuted} size="small" /> : null}
        </View>
      }
      label="This bot's memory"
    >
      <TextInput
        accessibilityLabel="Bot memory"
        multiline
        onBlur={() => void commit()}
        onChangeText={text => {
          setDraft(text)
          setError(null)
        }}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        scrollEnabled={false}
        style={[styles.editor, { color: colors.text }]}
        testID="memory-editor"
        textAlignVertical="top"
        value={draft}
      />
    </Group>
  )
}

function Dreaming({ bot, onRestored, save }: { bot: Bot; onRestored: (text: string) => void; save: (patch: BotUpdatePatch) => void }) {
  const { colors } = useTheme()
  const deploymentOn = useSettings(state => state.settings?.dream_enabled)
  const [status, setStatus] = useState<DreamStatus | null>(null)
  const [dreams, setDreams] = useState<Dream[]>([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<null | string>(null)

  useEffect(() => {
    if (!useSettings.getState().settings) {
      void useSettings.getState().refresh()
    }
  }, [])

  const load = useCallback(async () => {
    const [next, list] = await Promise.all([dreamingStatus(bot.name), dreamingList(bot.name)])

    setStatus(next)
    setDreams(list.dreams)
  }, [bot.name])

  useEffect(() => {
    void load().catch(caught => setError(errorText(caught)))
  }, [load, bot.dream_enabled])

  const run = async () => {
    setRunning(true)
    setError(null)

    try {
      await dreamingRunNow(bot.name)

      // Wait for the pass to finish: the newest dream stops saying "running".
      for (let attempt = 0; attempt < 45; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 1000))
        const [next, list] = await Promise.all([dreamingStatus(bot.name), dreamingList(bot.name)])

        setStatus(next)
        setDreams(list.dreams)

        if (attempt > 0 && !list.dreams.some(dream => dream.status === 'running')) {
          break
        }
      }

      const memory = await botMemoryGet(bot.name)

      onRestored(memory.memory_md)
      // The daemon makes the Dreams section on its own, without a sections event.
      void sectionsActions().refresh()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setRunning(false)
    }
  }

  const off = deploymentOn === false && status?.enabled === false
  const footer = off
    ? 'Dreaming is off for this daemon. Turn it on in Settings.'
    : 'Each day the bot reads its recent conversations and tidies its memory. Every dream keeps the memory it started from.'

  return (
    <>
      <Group error={error ?? (status?.last_error ? `Last dream failed: ${status.last_error}` : null)} footer={footer} label="Dreaming">
        <SwitchRow onValueChange={on => save({ dream_enabled: on })} testID="memory-dream-daily" title="Dream daily" value={bot.dream_enabled ?? true} />
        <Row title="Last dream" value={status ? when(status.last_run_at) : null} />
        <Row title="Next dream" value={status ? (status.enabled ? when(status.next_run_at) : 'Off') : null} />
        <Row
          right={
            <Button disabled={!status?.enabled} loading={running} onPress={() => void run()} style={styles.small} variant="secondary">
              Dream now
            </Button>
          }
          subtitle="Read the latest conversations without waiting for tonight."
          title="Run a pass now"
        />
      </Group>
      {dreams.length ? (
        <Group label="Dream log">
          {dreams.map(dream => (
            <DreamRow
              dream={dream}
              key={dream.id}
              onRestored={text => {
                onRestored(text)
                void load().catch(caught => setError(errorText(caught)))
              }}
            />
          ))}
        </Group>
      ) : status ? (
        <Text style={[styles.empty, { color: colors.textMuted }]}>No dreams yet.</Text>
      ) : null}
    </>
  )
}

function DreamRow({ dream, onRestored }: { dream: Dream; onRestored: (text: string) => void }) {
  const { colors } = useTheme()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<null | string>(null)
  const changed = typeof dream.memory_before === 'string' && typeof dream.memory_after === 'string' && dream.memory_before !== dream.memory_after

  const restore = () =>
    Alert.alert('Restore the memory from before this dream?', 'The current memory stays in the log, so you can come back to it.', [
      { style: 'cancel', text: 'Cancel' },
      {
        onPress: () =>
          void dreamingRestore(dream.id)
            .then(result => onRestored(result.memory_md))
            .catch(caught => setError(errorText(caught))),
        text: 'Restore'
      }
    ])

  return (
    <View>
      <Pressable
        accessibilityRole={changed ? 'button' : undefined}
        disabled={!changed}
        onPress={() => setOpen(value => !value)}
        style={({ pressed }) => [styles.dream, pressed && { backgroundColor: colors.surface3 }]}
      >
        <Text numberOfLines={open ? undefined : 2} style={[styles.dreamText, { color: colors.text }]}>
          {plain(dream.summary) || DREAM_STATUS[dream.status] || dream.status}
        </Text>
        <Text style={[styles.dreamMeta, { color: colors.textMuted }]}>
          {when(dream.started_at)}
          {changed ? (open ? ' · Hide what changed' : ' · What changed') : ''}
        </Text>
      </Pressable>
      {open && changed ? (
        <View style={styles.diff}>
          {(['Before', 'After'] as const).map(label => (
            <View key={label} style={{ gap: 4 }}>
              <Text style={[styles.dreamMeta, { color: colors.textMuted }]}>{label}</Text>
              <Text style={[styles.mono, { backgroundColor: colors.bg, color: colors.text }]}>
                {(label === 'Before' ? dream.memory_before : dream.memory_after) || '(empty)'}
              </Text>
            </View>
          ))}
          <Button onPress={restore} style={styles.small} variant="secondary">
            Restore the memory from before
          </Button>
          {error ? <Text style={{ color: colors.danger, fontSize: 13 }}>{error}</Text> : null}
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  counter: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  diff: { gap: 12, paddingBottom: 16, paddingHorizontal: 16 },
  dream: { gap: 4, paddingHorizontal: 16, paddingVertical: 12 },
  dreamMeta: { fontSize: 13 },
  dreamText: { fontSize: 16, lineHeight: 21 },
  editor: { fontSize: 16, lineHeight: 22, minHeight: 200, paddingHorizontal: 16, paddingVertical: 14 },
  empty: { fontSize: 15, textAlign: 'center' },
  mono: { borderRadius: 10, fontFamily: Platform.select({ default: 'monospace', ios: 'Menlo' }), fontSize: 12, lineHeight: 17, padding: 10 },
  small: { height: 36, paddingHorizontal: 14 }
})
