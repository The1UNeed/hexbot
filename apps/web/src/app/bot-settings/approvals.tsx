import type { Bot, BotApprovalMode } from '../../lib/types'

import { Heading, type SaveBot } from './shared'

export const BOT_APPROVAL_MODES: { description: string; label: string; value: BotApprovalMode }[] = [
  {
    description: 'Use the approval mode set in Settings for every bot.',
    label: 'Inherit',
    value: 'inherit'
  },
  {
    description: 'Ask before every tool action that needs permission.',
    label: 'Manual',
    value: 'manual'
  },
  {
    description: 'Let a small model approve low-risk actions and ask you about the rest.',
    label: 'Auto',
    value: 'smart'
  },
  { description: 'Run actions without approval prompts.', label: 'Off', value: 'off' }
]

export function ApprovalsTab({ bot, onSave }: { bot: Bot; onSave: SaveBot }) {
  const current = bot.approval_mode ?? 'inherit'

  return (
    <div>
      <Heading description="When Hexbot asks before this bot uses a protected tool. Rooms can override it again.">
        Approvals
      </Heading>
      <fieldset className="space-y-1">
        <legend className="sr-only">Approval mode</legend>
        {BOT_APPROVAL_MODES.map(mode => (
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
