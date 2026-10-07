import { Stack } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { Alert, StyleSheet, Text, TextInput, View } from 'react-native'
import { KeyboardAvoidingView, useKeyboardState } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useHeaderHeight } from 'expo-router/react-navigation'

import { BotPage } from '../../../components/bot/page'
import { errorText } from '../../../components/bot/use-bot'
import { BOT_TEMPLATES } from '../../../lib/bot-templates'
import type { Bot, BotUpdatePatch } from '../../../lib/types'
import { useTheme } from '../../../theme'

const wordCount = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0)

export default function Soul() {
  return (
    <BotPage scroll={false} title="Soul">
      {({ bot, save }) => <Editor bot={bot} save={save} />}
    </BotPage>
  )
}

/**
 * The soul as one full-height editor. It saves when the field loses focus or
 * the page closes; a template replaces it after a confirm.
 */
function Editor({ bot, save }: { bot: Bot; save: (patch: BotUpdatePatch) => Promise<unknown> }) {
  const { colors } = useTheme()
  const header = useHeaderHeight()
  const insets = useSafeAreaInsets()
  const keyboard = useKeyboardState(state => state.isVisible)
  const [draft, setDraft] = useState(bot.persona)
  const [focused, setFocused] = useState(false)
  const [state, setState] = useState<'error' | 'idle' | 'saved' | 'saving'>('idle')
  const [error, setError] = useState<null | string>(null)
  const latest = useRef({ draft, saved: bot.persona })

  latest.current.draft = draft

  useEffect(() => {
    latest.current.saved = bot.persona

    if (!focused) {
      setDraft(bot.persona)
    }
  }, [bot.persona, focused])

  const commit = async (text: string) => {
    if (text === latest.current.saved) {
      return
    }

    setState('saving')
    setError(null)

    try {
      await save({ persona: text })
      latest.current.saved = text
      setState('saved')
    } catch (caught) {
      setError(errorText(caught))
      setState('error')
    }
  }

  // Leaving the page with the keyboard up skips blur; save on the way out.
  useEffect(
    () => () => {
      if (latest.current.draft !== latest.current.saved) {
        void save({ persona: latest.current.draft }).catch(() => undefined)
      }
    },
    [save]
  )

  const useTemplate = (id: string) => {
    const template = BOT_TEMPLATES.find(item => item.id === id)

    if (!template) {
      return
    }

    const apply = () => {
      setDraft(template.persona)
      void commit(template.persona)
    }

    if (!draft.trim() || draft === template.persona) {
      return apply()
    }

    Alert.alert(`Use the ${template.title} template?`, 'It replaces the soul you have now.', [
      { style: 'cancel', text: 'Cancel' },
      { onPress: apply, style: 'destructive', text: 'Replace' }
    ])
  }

  const words = wordCount(draft)
  const status =
    state === 'saving'
      ? 'Saving'
      : state === 'error'
        ? error
        : draft !== latest.current.saved
          ? 'Saves when you leave the field'
          : state === 'saved'
            ? 'Saved'
            : null

  return (
    <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu accessibilityLabel="Templates" icon="text.badge.plus" title="Start from a template">
          {BOT_TEMPLATES.map(template => (
            <Stack.Toolbar.MenuAction key={template.id} onPress={() => useTemplate(template.id)} subtitle={template.description}>
              {template.title}
            </Stack.Toolbar.MenuAction>
          ))}
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={0} style={[styles.fill, { paddingTop: header + 4 }]}>
        <Text style={[styles.lead, { color: colors.textMuted }]}>
          Who this bot is: how it behaves and speaks. {bot.display_name} may edit it too, and says so when it does.
        </Text>
        <View style={[styles.card, { backgroundColor: colors.bubbleBot }]}>
          <TextInput
            accessibilityLabel="Soul"
            multiline
            onBlur={() => {
              setFocused(false)
              void commit(draft)
            }}
            onChangeText={text => {
              setDraft(text)
              setState('idle')
            }}
            onFocus={() => setFocused(true)}
            placeholder={`Describe how ${bot.display_name} thinks, talks, and works.`}
            placeholderTextColor={colors.textFaint}
            scrollEnabled
            style={[styles.editor, { color: colors.text }]}
            testID="soul-editor"
            textAlignVertical="top"
            value={draft}
          />
        </View>
        <View style={styles.meta}>
          <Text style={[styles.metaText, { color: colors.textMuted }]}>
            {words} {words === 1 ? 'word' : 'words'}
          </Text>
          {status ? (
            <Text numberOfLines={1} style={[styles.metaText, { color: state === 'error' ? colors.danger : colors.textMuted }]}>
              {status}
            </Text>
          ) : null}
        </View>
        <View style={{ height: keyboard ? 10 : Math.max(insets.bottom, 12) }} />
      </KeyboardAvoidingView>
    </>
  )
}

const styles = StyleSheet.create({
  card: { borderCurve: 'continuous', borderRadius: 24, flex: 1, marginHorizontal: 16, overflow: 'hidden' },
  editor: { flex: 1, fontSize: 17, lineHeight: 24, paddingHorizontal: 18, paddingVertical: 16 },
  fill: { flex: 1 },
  lead: { fontSize: 15, lineHeight: 20, paddingBottom: 12, paddingHorizontal: 32 },
  meta: { flexDirection: 'row', gap: 12, justifyContent: 'space-between', paddingHorizontal: 32, paddingTop: 8 },
  metaText: { flexShrink: 1, fontSize: 13 }
})
