import {
  Banner,
  BotFace,
  ChoiceRow,
  Field,
  Form,
  Group,
  ModalSheet,
  Row,
  SwitchRow,
  Text
} from '../ui'
import type { BotSummary } from './types'
import { useDraft } from './useDraft'

export interface RoomSettings {
  name: string
  memberIds: string[]
  mainBotId: string | null
}

export interface RoomSheetProps {
  visible: boolean
  onClose: () => void
  /** `create` starts empty and says Create; `edit` says Save. */
  mode: 'create' | 'edit'
  /** Every bot the user can add. */
  bots: BotSummary[]
  initial?: Partial<RoomSettings>
  onSave: (settings: RoomSettings) => void
  saving?: boolean
  error?: string | null
  archived?: boolean
  onArchive?: () => void
  onUnarchive?: () => void
  onDelete?: () => void
}

/** A room's name, its bots, and the main bot that answers when nobody is mentioned. */
export function RoomSheet({
  archived,
  bots,
  error,
  initial,
  mode,
  onArchive,
  onClose,
  onDelete,
  onSave,
  onUnarchive,
  saving,
  visible
}: RoomSheetProps) {
  const [draft, setDraft] = useDraft<RoomSettings>(
    {
      mainBotId: initial?.mainBotId ?? null,
      memberIds: initial?.memberIds ?? [],
      name: initial?.name ?? ''
    },
    visible
  )
  const members = bots.filter(bot => draft.memberIds.includes(bot.id))
  const name = draft.name.trim()

  const toggle = (id: string, on: boolean) =>
    setDraft(value => {
      const memberIds = on
        ? [...value.memberIds, id]
        : value.memberIds.filter(member => member !== id)

      return {
        ...value,
        mainBotId: memberIds.includes(value.mainBotId ?? '') ? value.mainBotId : null,
        memberIds
      }
    })

  return (
    <ModalSheet
      action={{
        busy: saving,
        busyLabel: mode === 'create' ? 'Creating…' : 'Saving…',
        disabled: !name || draft.memberIds.length === 0,
        label: mode === 'create' ? 'Create' : 'Save',
        onPress: () => onSave({ ...draft, name })
      }}
      onClose={onClose}
      testID="room-sheet"
      title={mode === 'create' ? 'New room' : 'Room settings'}
      visible={visible}
    >
      <Form>
        {error ? <Banner message={error} testID="room-sheet-error" title="Not saved" /> : null}
        <Field
          autoCapitalize="sentences"
          label="Name"
          onChangeText={text => setDraft(value => ({ ...value, name: text }))}
          placeholder="Launch planning"
          testID="room-sheet-name"
          value={draft.name}
        />

        <Group separatorInset={64} title="Bots in this room">
          {bots.map(bot => (
            <SwitchRow
              key={bot.id}
              leading={<BotFace {...bot} size={36} />}
              onValueChange={on => toggle(bot.id, on)}
              subtitle={bot.title}
              testID={`room-sheet-bot-${bot.id}`}
              title={bot.name}
              value={draft.memberIds.includes(bot.id)}
            />
          ))}
        </Group>
        {bots.length === 0 ? (
          <Text align="center" tone="muted" variant="callout">
            Create a bot first, then add it here.
          </Text>
        ) : null}

        {members.length > 1 ? (
          <Group footer="The main bot answers when a message mentions nobody." title="Main bot">
            <ChoiceRow
              onPress={() => setDraft(value => ({ ...value, mainBotId: null }))}
              selected={draft.mainBotId === null}
              subtitle="Only mentioned bots answer"
              testID="room-sheet-main-none"
              title="None"
            />
            {members.map(bot => (
              <ChoiceRow
                key={bot.id}
                leading={<BotFace {...bot} size={28} />}
                onPress={() => setDraft(value => ({ ...value, mainBotId: bot.id }))}
                selected={draft.mainBotId === bot.id}
                testID={`room-sheet-main-${bot.id}`}
                title={bot.name}
              />
            ))}
          </Group>
        ) : null}

        {mode === 'edit' && (onArchive || onUnarchive || onDelete) ? (
          <Group>
            {archived && onUnarchive ? (
              <Row onPress={onUnarchive} testID="room-sheet-unarchive" title="Unarchive room" />
            ) : null}
            {!archived && onArchive ? (
              <Row onPress={onArchive} testID="room-sheet-archive" title="Archive room" />
            ) : null}
            {onDelete ? (
              <Row destructive onPress={onDelete} testID="room-sheet-delete" title="Delete room" />
            ) : null}
          </Group>
        ) : null}
      </Form>
    </ModalSheet>
  )
}
