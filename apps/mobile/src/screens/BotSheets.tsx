import { StyleSheet, View } from 'react-native'

import {
  Banner,
  BotFace,
  ChoiceRow,
  FacePicker,
  type FaceStyle,
  faceForName,
  Field,
  Form,
  Group,
  ModalSheet,
  Segmented,
  SwitchRow,
  Text
} from '../ui'
import type { BotSummary, ModelChoice, ToolToggle } from './types'
import { useDraft } from './useDraft'

export type BotSettingsPage = 'memory' | 'model' | 'soul' | 'tools'

/** Only the fields the user changed. */
export interface BotSettingsChanges {
  soul?: string
  memory?: string
  modelId?: string
  /** Tool id to its new state. */
  tools?: Record<string, boolean>
}

export interface BotSettingsSheetProps {
  visible: boolean
  onClose: () => void
  bot: BotSummary
  soul: string
  memory: string
  models: ModelChoice[]
  modelId: string | null
  tools: ToolToggle[]
  onSave: (changes: BotSettingsChanges) => void
  initialPage?: BotSettingsPage
  saving?: boolean
  error?: string | null
}

/** Group models by provider, keeping the order they came in. */
function byProvider(models: ModelChoice[]) {
  const groups = new Map<string, ModelChoice[]>()

  models.forEach(model =>
    groups.set(model.provider, [...(groups.get(model.provider) ?? []), model])
  )

  return [...groups.entries()]
}

/** A bot's soul, memory, model and tools, edited together and saved once. */
export function BotSettingsSheet({
  bot,
  error,
  initialPage = 'soul',
  memory,
  modelId,
  models,
  onClose,
  onSave,
  saving,
  soul,
  tools,
  visible
}: BotSettingsSheetProps) {
  const enabled = Object.fromEntries(tools.map(tool => [tool.id, tool.enabled]))
  const [page, setPage] = useDraft<BotSettingsPage>(initialPage, visible)
  const [draft, setDraft] = useDraft({ memory, modelId, soul, tools: enabled }, visible)

  const changes: BotSettingsChanges = {}

  if (draft.soul !== soul) changes.soul = draft.soul
  if (draft.memory !== memory) changes.memory = draft.memory
  if (draft.modelId && draft.modelId !== modelId) changes.modelId = draft.modelId

  const toolChanges = Object.fromEntries(
    Object.entries(draft.tools).filter(([id, on]) => enabled[id] !== on)
  )

  if (Object.keys(toolChanges).length) changes.tools = toolChanges

  const dirty = Object.keys(changes).length > 0

  return (
    <ModalSheet
      action={{
        busy: saving,
        busyLabel: 'Saving…',
        disabled: !dirty,
        label: 'Save',
        onPress: () => onSave(changes)
      }}
      header={
        <View style={styles.pinned}>
          <View style={styles.identity}>
            <BotFace {...bot} size={40} />
            <View style={styles.identityText}>
              <Text numberOfLines={1} variant="headline">
                {bot.name}
              </Text>
              {bot.title ? (
                <Text numberOfLines={1} tone="muted" variant="footnote">
                  {bot.title}
                </Text>
              ) : null}
            </View>
          </View>
          <Segmented
            onChange={setPage}
            options={[
              { key: 'soul', label: 'Soul' },
              { key: 'memory', label: 'Memory' },
              { key: 'model', label: 'Model' },
              { key: 'tools', label: 'Tools' }
            ]}
            selected={page}
            testID="bot-settings-page"
          />
        </View>
      }
      onClose={onClose}
      testID="bot-settings"
      title="Bot settings"
      visible={visible}
    >
      <Form>
        {error ? <Banner message={error} testID="bot-settings-error" title="Not saved" /> : null}

        {page === 'soul' ? (
          <Field
            hint="Who the bot is and how it talks. The bot can edit this too, and tells you when it does."
            label="Soul"
            minHeight={280}
            multiline
            onChangeText={text => setDraft(value => ({ ...value, soul: text }))}
            placeholder="You are a calm research assistant. You answer in short paragraphs."
            testID="bot-settings-soul"
            value={draft.soul}
          />
        ) : null}

        {page === 'memory' ? (
          <Field
            hint="The bot writes these notes during chat, and dreaming tidies them each day. Deleting a conversation leaves them alone."
            label="Memory"
            minHeight={280}
            multiline
            onChangeText={text => setDraft(value => ({ ...value, memory: text }))}
            placeholder="Nothing yet."
            testID="bot-settings-memory"
            value={draft.memory}
          />
        ) : null}

        {page === 'model'
          ? byProvider(models).map(([provider, list]) => (
              <Group key={provider} title={provider}>
                {list.map(model => (
                  <ChoiceRow
                    key={model.id}
                    onPress={() => setDraft(value => ({ ...value, modelId: model.id }))}
                    selected={draft.modelId === model.id}
                    subtitle={model.detail}
                    testID={`bot-settings-model-${model.id}`}
                    title={model.label}
                  />
                ))}
              </Group>
            ))
          : null}
        {page === 'model' && models.length === 0 ? (
          <Text align="center" tone="muted" variant="callout">
            No models yet. Add a provider in the daemon's settings.
          </Text>
        ) : null}

        {page === 'tools' ? (
          <Group footer="Tools the daemon's computer is not set up for stay off.">
            {tools.map(tool => (
              <SwitchRow
                disabled={tool.available === false}
                key={tool.id}
                onValueChange={on =>
                  setDraft(value => ({ ...value, tools: { ...value.tools, [tool.id]: on } }))
                }
                subtitle={
                  tool.available === false ? 'Not set up on this computer' : tool.description
                }
                testID={`bot-settings-tool-${tool.id}`}
                title={tool.label}
                value={!!draft.tools[tool.id] && tool.available !== false}
              />
            ))}
          </Group>
        ) : null}
      </Form>
    </ModalSheet>
  )
}

export interface NewBot {
  name: string
  face: FaceStyle
  modelId: string | null
}

/** Name a bot, give it a face, pick its model. */
export function NewBotSheet({
  creating,
  error,
  models,
  onClose,
  onCreate,
  visible
}: {
  visible: boolean
  onClose: () => void
  onCreate: (bot: NewBot) => void
  models: ModelChoice[]
  creating?: boolean
  error?: string | null
}) {
  const [draft, setDraft] = useDraft<{
    face: FaceStyle | null
    modelId: string | null
    name: string
  }>({ face: null, modelId: models[0]?.id ?? null, name: '' }, visible)
  const name = draft.name.trim()
  const face = draft.face ?? faceForName(name || 'New bot')

  return (
    <ModalSheet
      action={{
        busy: creating,
        busyLabel: 'Creating…',
        disabled: !name || !draft.modelId,
        label: 'Create',
        onPress: () => onCreate({ face, modelId: draft.modelId, name })
      }}
      onClose={onClose}
      testID="new-bot"
      title="New bot"
      visible={visible}
    >
      <Form>
        {error ? <Banner message={error} testID="new-bot-error" title="Not created" /> : null}
        <FacePicker
          onChange={next => setDraft(value => ({ ...value, face: next }))}
          testID="new-bot-face"
          value={face}
        />
        <Field
          autoCapitalize="words"
          label="Name"
          onChangeText={text => setDraft(value => ({ ...value, name: text }))}
          placeholder="Inbox Manager"
          returnKeyType="done"
          testID="new-bot-name"
          value={draft.name}
        />
        {byProvider(models).map(([provider, list]) => (
          <Group key={provider} title={provider}>
            {list.map(model => (
              <ChoiceRow
                key={model.id}
                onPress={() => setDraft(value => ({ ...value, modelId: model.id }))}
                selected={draft.modelId === model.id}
                subtitle={model.detail}
                testID={`new-bot-model-${model.id}`}
                title={model.label}
              />
            ))}
          </Group>
        ))}
      </Form>
    </ModalSheet>
  )
}

const styles = StyleSheet.create({
  identity: { alignItems: 'center', flexDirection: 'row', gap: 12 },
  identityText: { flex: 1 },
  pinned: { gap: 14 }
})
