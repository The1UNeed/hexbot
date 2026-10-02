import { useApprovalModes } from '../../lib/approval-modes'
import type { Bot } from '../../lib/types'

import { Heading, type SaveBot } from './shared'

export function ApprovalsTab({ bot, onSave }: { bot: Bot; onSave: SaveBot }) {
  const current = bot.approval_mode ?? 'inherit'

  const modes = [
    {
      description: 'Use the approval mode set in Settings.',
      label: 'Inherit',
      value: 'inherit' as const
    },
    ...useApprovalModes(current)
  ]

  return (
    <div>
      <Heading description="When Hexbot asks before this bot acts. Rooms can override it.">
        Approvals
      </Heading>
      <fieldset className="space-y-1">
        <legend className="sr-only">Approval mode</legend>
        {modes.map(mode => (
          <label className="flex cursor-pointer gap-3 border-b border-border py-3" key={mode.value}>
            <input
              checked={current === mode.value}
              name="bot-approval-mode"
              onChange={() => void onSave({ approval_mode: mode.value })}
              type="radio"
              value={mode.value}
            />
            <span>
              <strong className="block">{mode.label}</strong>
              <span className="text-[length:var(--text-secondary)] text-muted">
                {mode.description}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
    </div>
  )
}
