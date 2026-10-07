import { router } from 'expo-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import Animated, { ZoomIn } from 'react-native-reanimated'

import { FacePicker, FaceRaster, type FaceRasterHandle } from '../../components/bot/face-picker'
import { type ModelChoice, ModelPicker, useModels } from '../../components/bot/model-picker'
import { Button } from '../../components/button'
import { FaceDrawing } from '../../components/face'
import { GlassButton } from '../../components/glass'
import { DEFAULT_AVATAR_STYLE, type AvatarStyle, styleForName } from '../../lib/avatar-builder'
import { toHandle } from '../../lib/bot-handle'
import { openSection } from '../../lib/navigation'
import { useBots } from '../../stores/bots'
import { introduceBot } from '../../stores/sections'
import { useSettings } from '../../stores/settings'
import { useTheme } from '../../theme'

const FACE = 128

const splitModel = (value?: null | string): ModelChoice => {
  const [provider = '', ...rest] = (value ?? '').split('/')

  return { model: rest.join('/'), provider }
}

/**
 * New bot: a face and a name, nothing else. Provider and model come from the
 * defaults; "Change" reveals them. The bot asks the rest itself once its
 * first section opens (docs/ui-design.md, "States: New bot").
 */
export default function NewBot() {
  const { colors } = useTheme()
  const defaultModel = useSettings(state => state.settings?.default_model)
  const taken = useBots(state => state.byName)
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<AvatarStyle | null>(null)
  const [choice, setChoice] = useState<ModelChoice>(() => splitModel(defaultModel))
  const [changing, setChanging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)
  const raster = useRef<FaceRasterHandle>(null)
  const models = useModels(choice.provider || null)

  const handle = toHandle(name)
  // Until a face is picked it follows the name, exactly as the daemon will draw it.
  const face = picked ?? (handle ? styleForName(handle) : DEFAULT_AVATAR_STYLE)

  useEffect(() => {
    if (!useSettings.getState().settings) {
      void useSettings.getState().refresh()
    }
  }, [])

  useEffect(() => {
    setChoice(current => (current.provider ? current : splitModel(defaultModel)))
  }, [defaultModel])

  // A provider switch empties the model; take its first recommended one.
  useEffect(() => {
    if (!choice.model && !models.loading) {
      const first = models.curated[0] ?? models.all[0]

      if (first) {
        setChoice(current => (current.model ? current : { ...current, model: first.id }))
      }
    }
  }, [choice.model, models])

  const modelLabel = useMemo(
    () => [...models.curated, ...models.all].find(item => item.id === choice.model)?.label ?? choice.model,
    [choice.model, models]
  )

  const missingModel = !choice.provider || !choice.model
  const showModel = changing || (missingModel && !models.loading)

  const create = async () => {
    if (!handle) {
      return setError('Give the bot a name with at least one letter or digit.')
    }

    if (taken[handle]) {
      return setError(`There is already a bot called ${taken[handle]!.display_name}.`)
    }

    setBusy(true)
    setError(null)

    try {
      const avatar = picked ? await raster.current?.capture(picked) : null
      const { bot, section } = await useBots.getState().create({
        display_name: name.trim(),
        model: choice.model,
        name: handle,
        provider: choice.provider,
        ...(avatar ? { avatar } : {})
      })

      router.back()
      openSection(section.id)
      void introduceBot(section, bot)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setBusy(false)
    }
  }

  return (
    <View style={{ backgroundColor: colors.bg, flex: 1 }}>
      <View style={styles.bar}>
        <GlassButton accessibilityLabel="Cancel" icon="xmark" onPress={() => router.back()} />
        <Text style={[styles.title, { color: colors.text }]}>New bot</Text>
        <View style={{ width: 44 }} />
      </View>
      <KeyboardAwareScrollView
        bottomOffset={24}
        contentContainerStyle={styles.content}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      >
        <Animated.View entering={ZoomIn.duration(220)} key={`${face.shape}-${face.color}`} style={styles.face} testID="new-bot-face">
          <FaceDrawing size={FACE} style={face} />
        </Animated.View>
        <FacePicker onChange={setPicked} value={face} />

        <View style={[styles.nameCard, { backgroundColor: colors.bubbleBot }]}>
          <TextInput
            accessibilityLabel="Bot name"
            autoCapitalize="words"
            autoCorrect={false}
            maxLength={64}
            onChangeText={text => {
              setName(text)
              setError(null)
            }}
            onSubmitEditing={() => void create()}
            placeholder="Name"
            placeholderTextColor={colors.textFaint}
            returnKeyType="done"
            style={[styles.name, { color: colors.text }]}
            testID="new-bot-name"
            value={name}
          />
        </View>
        <Text style={[styles.hint, { color: error ? colors.danger : colors.textMuted }]}>
          {error ?? (handle ? `@${handle}. It asks you the rest in its first section.` : 'It asks you the rest in its first section.')}
        </Text>

        {showModel ? (
          <View style={styles.models}>
            <ModelPicker onChange={setChoice} value={choice} />
          </View>
        ) : (
          <Pressable accessibilityRole="button" onPress={() => setChanging(true)} style={styles.runsOn} testID="new-bot-change-model">
            <Text numberOfLines={1} style={[styles.runsOnText, { color: colors.textMuted }]}>
              Runs on {modelLabel || 'the default model'}
            </Text>
            <Text style={[styles.runsOnText, { color: colors.text, fontWeight: '600' }]}>Change</Text>
          </Pressable>
        )}

        <Button disabled={!handle || missingModel} loading={busy} onPress={() => void create()} style={styles.create}>
          Create
        </Button>
      </KeyboardAwareScrollView>
      <FaceRaster ref={raster} />
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 16 },
  content: { gap: 20, paddingBottom: 40, paddingHorizontal: 20, paddingTop: 8 },
  create: { marginTop: 4 },
  face: { alignItems: 'center', height: FACE, justifyContent: 'center', marginBottom: 4 },
  hint: { fontSize: 13, lineHeight: 18, marginTop: -12, paddingHorizontal: 16, textAlign: 'center' },
  models: { gap: 24 },
  name: { fontSize: 20, fontWeight: '500', height: 56, textAlign: 'center' },
  nameCard: { borderCurve: 'continuous', borderRadius: 24, paddingHorizontal: 16 },
  runsOn: { alignItems: 'center', alignSelf: 'center', flexDirection: 'row', gap: 6, maxWidth: '100%', paddingVertical: 4 },
  runsOnText: { flexShrink: 1, fontSize: 15 },
  title: { fontSize: 17, fontWeight: '600' }
})
