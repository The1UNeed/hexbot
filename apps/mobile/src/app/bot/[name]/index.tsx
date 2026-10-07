import { Stack } from 'expo-router'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'

import { FaceEditor } from '../../../components/bot/face-editor'
import { runningLabel } from '../../../components/chat/steps'
import { openPage, useBotSheet } from '../../../components/bot/nav'
import { useBotRoute, useBotSave } from '../../../components/bot/use-bot'
import { Group, ListScroll, Row, SwitchRow, TextFieldRow } from '../../../components/list'
import { APPROVAL_MODES } from '../../../lib/approval-modes'
import type { Bot, BotUpdatePatch } from '../../../lib/types'
import { useSections } from '../../../stores/sections'
import { useSettings } from '../../../stores/settings'
import { useTranscripts } from '../../../stores/transcripts'
import { type Palette, useTheme } from '../../../theme'

const DOORS: { icon: string; page: string; title: string }[] = [
  { icon: 'quote.bubble', page: 'soul', title: 'Soul' },
  { icon: 'brain', page: 'memory', title: 'Memory' },
  { icon: 'wrench.and.screwdriver', page: 'tools', title: 'Tools' },
  { icon: 'powerplug', page: 'connectors', title: 'Connectors' },
  { icon: 'sparkles', page: 'skills', title: 'Skills' },
  { icon: 'checkmark.shield', page: 'approvals', title: 'Approvals' },
  { icon: 'bubble.left.and.bubble.right', page: 'sections', title: 'Sections' }
]

/**
 * The bot sheet, opened from the name pill above a chat: the face, the name
 * and label as bare fields, the description, then the model, notifications
 * and the doors into the bot's settings. Fields save on blur, switches on
 * change.
 */
export default function BotSheet() {
  const { colors } = useTheme()
  const { bot, loaded, name } = useBotRoute()
  const { error, save } = useBotSave(name)
  const sheet = useBotSheet()

  return (
    <>
      <Stack.Screen options={{ headerTransparent: true, title: '' }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button accessibilityLabel="Done" icon="xmark" onPress={() => sheet.close()} />
      </Stack.Toolbar>
      {bot ? (
        <Body bot={bot} colors={colors} error={error} onSave={save} />
      ) : (
        <View style={styles.center}>
          {loaded ? <Text style={{ color: colors.textMuted, fontSize: 17 }}>This bot is gone.</Text> : <ActivityIndicator color={colors.textMuted} />}
        </View>
      )}
    </>
  )
}

function Body({
  bot,
  colors,
  error,
  onSave
}: {
  bot: Bot
  colors: Palette
  error: null | string
  onSave: (patch: BotUpdatePatch) => Promise<unknown>
}) {
  const sheet = useBotSheet()
  // The header is the close button's row; the face starts in it.
  const header = useHeaderHeight()
  const settings = useSettings(state => state.settings)
  const live = useLiveActivity(bot.name)
  const working = bot.status === 'working' || Boolean(live)
  const waiting = bot.status === 'needs_you'
  const statusSection = bot.status_detail?.section_id ?? live?.sectionId ?? null
  const statusText = ((bot.status === 'working' || waiting) && bot.status_detail?.text) || live?.text || (working ? 'Working' : waiting ? 'Needs you' : null)
  const quiet = (patch: BotUpdatePatch) => void onSave(patch).catch(() => undefined)

  useEffect(() => {
    if (!settings) {
      void useSettings.getState().refresh()
    }
  }, [settings])

  const mode = bot.approval_mode && bot.approval_mode !== 'inherit' ? bot.approval_mode : null
  const approvals = mode ? (APPROVAL_MODES.find(item => item.value === mode)?.label ?? mode) : 'Inherit'

  return (
    // The face sits level with the close button, the way a contact card opens.
    <ListScroll contentContainerStyle={{ paddingTop: Math.max(16, header - 12) }} contentInsetAdjustmentBehavior="never" testID="bot-sheet">
      <View style={styles.head}>
        <FaceEditor bot={bot} onSave={onSave} size={112} status={waiting ? 'needs_you' : working ? 'working' : undefined} />
        <BareField
          accessibilityLabel="Bot name"
          onSave={value => (value.trim() ? onSave({ display_name: value.trim() }) : Promise.reject(new Error('A bot needs a name.')))}
          style={[styles.name, bot.display_name.length > 18 && styles.nameLong, { color: colors.text }]}
          testID="bot-name"
          value={bot.display_name}
        />
        <BareField
          accessibilityLabel="Label"
          onSave={value => onSave({ title: value.trim() })}
          placeholder="Add a label"
          style={[styles.label, { color: colors.textMuted }]}
          testID="bot-label"
          value={bot.title}
        />
        {statusText ? (
          <Pressable
            accessibilityRole="button"
            disabled={!statusSection}
            onPress={() => statusSection && sheet.openAfterClose(statusSection)}
            style={[styles.chip, { backgroundColor: (waiting ? colors.accent : colors.working) + '1F' }]}
            testID="bot-status"
          >
            <View style={[styles.chipDot, { backgroundColor: waiting ? colors.accent : colors.working }]} />
            <Text numberOfLines={1} style={[styles.chipText, { color: waiting ? colors.accent : colors.working }]}>
              {statusText}
            </Text>
          </Pressable>
        ) : null}
        {error ? <Text style={[styles.error, { color: colors.danger }]}>{error}</Text> : null}
      </View>

      <Group footer={`Other bots read this to decide when to ask ${bot.display_name} for help.`} label="Description">
        <TextFieldRow
          multiline
          onCommit={value => onSave({ description: value.trim() })}
          placeholder={`What ${bot.display_name} is for`}
          testID="bot-description"
          value={bot.description}
        />
      </Group>

      <Group>
        <Row
          chevron
          icon="cpu"
          onPress={() => openPage(bot.name, 'model')}
          testID="bot-door-model"
          title="Model"
          value={bot.model || 'Default'}
        />
        <SwitchRow
          icon="bell"
          onValueChange={value => quiet({ notify: value })}
          subtitle="When it stops or needs you"
          testID="bot-notify"
          title="Notify me"
          value={bot.notify ?? true}
        />
      </Group>

      <Group>
        {DOORS.map(door => (
          <Row
            chevron
            icon={door.icon}
            key={door.page}
            onPress={() => openPage(bot.name, door.page)}
            testID={`bot-door-${door.page}`}
            title={door.title}
            value={door.page === 'approvals' ? approvals : door.page === 'sections' && bot.sections_total ? String(bot.sections_total) : null}
          />
        ))}
      </Group>

      <Group>
        <Row chevron icon="slider.horizontal.3" onPress={() => openPage(bot.name, 'advanced')} testID="bot-door-advanced" title="Advanced" />
      </Group>
    </ListScroll>
  )
}

/**
 * What the bot is doing right now in one of its open sections, from the live
 * transcript: the running step in plain words, or "Writing". The daemon's
 * status arrives later and covers sections this phone has not opened.
 */
function useLiveActivity(botName: string): null | { sectionId: string; text: string } {
  const key = useTranscripts(state => {
    const { byId, liveSessionId } = useSections.getState()

    for (const [sectionId, sessionId] of Object.entries(liveSessionId)) {
      const transcript = state.bySession[sessionId]

      if (byId[sectionId]?.bot !== botName || !transcript?.streamingMessageId) {
        continue
      }

      const message = transcript.messages.at(-1)

      return `${sectionId}\n${(message && runningLabel(message)) || 'Writing'}`
    }

    return ''
  })

  if (!key) {
    return null
  }

  const [sectionId = '', text = ''] = key.split('\n')

  return { sectionId, text }
}

/** A centred field with no chrome that saves on blur; a failed save puts the old text back. */
function BareField({
  accessibilityLabel,
  onSave,
  placeholder,
  style,
  testID,
  value
}: {
  accessibilityLabel: string
  onSave: (value: string) => Promise<unknown>
  placeholder?: string
  style: object
  testID: string
  value: string
}) {
  const { colors } = useTheme()
  const [draft, setDraft] = useState(value)
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!focused) {
      setDraft(value)
    }
  }, [focused, value])

  const commit = () => {
    setFocused(false)

    if (draft.trim() !== value.trim()) {
      void onSave(draft).catch(() => setDraft(value))
    }
  }

  return (
    <TextInput
      accessibilityLabel={accessibilityLabel}
      autoCorrect={false}
      maxLength={80}
      // Multiline so a long name wraps instead of scrolling out of sight; return still saves.
      multiline
      onBlur={commit}
      onChangeText={text => setDraft(text.replace(/\s*\n\s*/g, ' '))}
      onFocus={() => setFocused(true)}
      onSubmitEditing={commit}
      placeholder={placeholder}
      placeholderTextColor={colors.textFaint}
      returnKeyType="done"
      scrollEnabled={false}
      submitBehavior="blurAndSubmit"
      style={[styles.bare, focused && { backgroundColor: colors.bubbleBot }, style]}
      testID={testID}
      value={draft}
    />
  )
}

const styles = StyleSheet.create({
  bare: { alignSelf: 'center', borderRadius: 12, maxWidth: '90%', minWidth: 120, paddingHorizontal: 10, paddingVertical: 2, textAlign: 'center' },
  center: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  chip: { alignItems: 'center', borderRadius: 999, flexDirection: 'row', gap: 6, marginTop: 6, maxWidth: '90%', paddingHorizontal: 12, paddingVertical: 6 },
  chipDot: { borderRadius: 4, height: 7, width: 7 },
  chipText: { flexShrink: 1, fontSize: 14, fontWeight: '600' },
  error: { fontSize: 13, marginTop: 4, textAlign: 'center' },
  head: { alignItems: 'center', gap: 2 },
  label: { fontSize: 17, lineHeight: 22 },
  name: { fontSize: 28, fontWeight: '700', lineHeight: 34, marginTop: 10 },
  nameLong: { fontSize: 24, lineHeight: 30 }
})
