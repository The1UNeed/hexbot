import { Stack } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'

import { errorText, KeyboardListScroll, PageState, useOnReconnect } from '../../components/settings/kit'
import { userMemoryGet, userMemorySet } from '../../lib/api'
import { useTheme } from '../../theme'

type Save = 'error' | 'idle' | 'saved' | 'saving'

/**
 * About you: one text per user, written only by the user and read by every
 * bot they own. One card-shaped editor, saved when it loses focus.
 */
export default function AboutYou() {
  const { colors } = useTheme()
  const [loaded, setLoaded] = useState<{ cap: number; text: string } | null>(null)
  const [loadError, setLoadError] = useState<null | string>(null)
  const [draft, setDraft] = useState('')
  const [save, setSave] = useState<Save>('idle')
  const [saveError, setSaveError] = useState<null | string>(null)
  const saved = useRef('')
  const loadedRef = useRef(false)

  const load = useCallback(() => {
    setLoadError(null)
    userMemoryGet()
      .then(memory => {
        saved.current = memory.text
        loadedRef.current = true
        setDraft(memory.text)
        setLoaded({ cap: memory.cap, text: memory.text })
      })
      .catch(error => setLoadError(errorText(error)))
  }, [])

  useEffect(load, [load])
  useOnReconnect(useCallback(() => !loadedRef.current && load(), [load]))

  // Leaving the page (or the sheet) without blurring the field still saves it.
  const latest = useRef(draft)
  latest.current = draft
  useEffect(
    () => () => {
      if (loadedRef.current && latest.current !== saved.current) {
        void userMemorySet(latest.current).catch(() => undefined)
      }
    },
    []
  )

  const commit = async () => {
    if (draft === saved.current) {
      return
    }

    setSave('saving')
    setSaveError(null)

    try {
      const memory = await userMemorySet(draft)

      saved.current = memory.text
      setSave('saved')
    } catch (error) {
      setSave('error')
      setSaveError(errorText(error))
    }
  }

  const cap = loaded?.cap ?? 2000
  const near = draft.length > cap * 0.9
  const status = save === 'saving' ? 'Saving…' : save === 'saved' && draft === saved.current ? 'Saved' : ''

  return (
    <>
      <Stack.Screen options={{ title: 'About you' }} />
      {loaded ? (
        <KeyboardListScroll testID="about-you">
          <View>
            <View style={[styles.card, { backgroundColor: colors.bubbleBot }]}>
              <TextInput
                accessibilityLabel="About you"
                maxLength={cap}
                multiline
                onBlur={() => void commit()}
                onChangeText={text => {
                  setDraft(text)

                  if (save !== 'saving') {
                    setSave('idle')
                  }
                }}
                placeholder="Your name, what you do, and how you like to be spoken to."
                placeholderTextColor={colors.textFaint}
                scrollEnabled={false}
                style={[styles.input, { color: colors.text }]}
                testID="about-you-input"
                value={draft}
              />
              <View style={styles.meta}>
                <Text style={[styles.status, { color: colors.textMuted }]} testID="about-you-status">
                  {status}
                </Text>
                <Text style={[styles.counter, { color: near ? colors.warning : colors.textFaint }]}>
                  {draft.length.toLocaleString()} / {cap.toLocaleString()}
                </Text>
              </View>
            </View>
            {saveError ? (
              <Text accessibilityRole="alert" style={[styles.footer, { color: colors.danger }]}>
                {saveError}
              </Text>
            ) : (
              <Text style={[styles.footer, { color: colors.textMuted }]}>Every bot you own reads this. Only you write it.</Text>
            )}
          </View>
        </KeyboardListScroll>
      ) : (
        <View style={styles.fill}>
          <View style={{ height: 120 }} />
          <PageState error={loadError} onRetry={load} />
        </View>
      )}
    </>
  )
}

const styles = StyleSheet.create({
  card: { borderCurve: 'continuous', borderRadius: 24, paddingBottom: 12, paddingHorizontal: 18, paddingTop: 14 },
  counter: { fontSize: 13, fontVariant: ['tabular-nums'] },
  fill: { flex: 1 },
  footer: { fontSize: 13, lineHeight: 18, paddingHorizontal: 16, paddingTop: 8 },
  input: { fontSize: 17, lineHeight: 24, minHeight: 220, padding: 0, textAlignVertical: 'top' },
  meta: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingTop: 10 },
  status: { fontSize: 13 }
})
