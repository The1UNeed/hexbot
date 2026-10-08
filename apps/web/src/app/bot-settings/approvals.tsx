import { APPROVAL_MODES } from '../../lib/approval-modes'
import type { Bot } from '../../lib/types'

import { ChoiceRow, dividerClass, Group, Heading, type SaveBot } from './shared'

export function ApprovalsTab({ bot, onSave }: { bot: Bot; onSave: SaveBot }) {
  const current = bot.approval_mode ?? 'inherit'

  const modes = [
    {
      description: 'Use the approval mode set in Settings.',
      label: 'Inherit',
      value: 'inherit' as const
    },
    ...APPROVAL_MODES
  ]

  return (
    <div>
      <Heading description="When Hexbot asks before this bot acts. Rooms can override it.">
        Approvals
      </Heading>
      <Group title="Mode">
        <div aria-label="Approval mode" className={dividerClass} role="radiogroup">
          {modes.map(mode => (
            <ChoiceRow
              checked={current === mode.value}
              description={mode.description}
              key={mode.value}
              onSelect={() => void onSave({ approval_mode: mode.value })}
              title={mode.label}
            />
          ))}
        </div>
      </Group>
    </div>
  )
}
