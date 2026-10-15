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
      <Group footer="This daemon keeps several conversations per bot. Pick one to continue. Your choice is saved for the update. If dream reports obscure that choice, Hexbot keeps all histories and may open another chat. Other histories are removed only after a full backup and a safe selection.">
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
