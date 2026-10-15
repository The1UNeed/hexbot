import type { Section } from '../core/types'
import { formatListTime, Group, ModalSheet, Row } from '../ui'

export interface ChatChooserProps {
  /** The bot's name as shown, while asked; null hides the sheet. */
  name: string | null
  choices: Section[]
  /** The section picked, or null when closed without one. */
  onChoose: (section: Section | null) => void
}

/**
 * Asks which section is a bot's chat on a daemon from before one chat per
 * bot, when that daemon's list cannot say. Closing it opens and makes nothing.
 */
export function ChatChooser({ choices, name, onChoose }: ChatChooserProps) {
  return (
    <ModalSheet
      onClose={() => onChoose(null)}
      testID="chat-chooser"
      title={`Continue with ${name ?? ''}`}
      visible={name !== null}
    >
      <Group footer="This daemon is older than the app and keeps several sections for each bot. Pick one to continue. When the daemon updates, the one you carry on in stays unless it began with a dream report, and the others are deleted after a full backup.">
        {choices.map(section => (
          <Row
            chevron
            key={section.id}
            meta={
              section.archived_at
                ? 'Archived'
                : formatListTime(section.updated_at == null ? null : section.updated_at * 1000)
            }
            onPress={() => onChoose(section)}
            subtitle={section.preview || null}
            testID={`chat-chooser-${section.id}`}
            title={section.title}
          />
        ))}
      </Group>
    </ModalSheet>
  )
}
