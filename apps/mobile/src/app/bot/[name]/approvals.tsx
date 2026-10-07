import { useEffect } from 'react'

import { BotPage } from '../../../components/bot/page'
import { CheckRow, Group } from '../../../components/list'
import { APPROVAL_MODES, useApprovalModes } from '../../../lib/approval-modes'
import type { BotApprovalMode } from '../../../lib/types'
import { useSettings } from '../../../stores/settings'

export default function Approvals() {
  return (
    <BotPage lead="When Hexbot asks before this bot acts. Rooms can override it." title="Approvals">
      {({ bot, quietly }) => <Modes current={bot.approval_mode ?? 'inherit'} onPick={mode => quietly({ approval_mode: mode })} />}
    </BotPage>
  )
}

function Modes({ current, onPick }: { current: BotApprovalMode; onPick: (mode: BotApprovalMode) => void }) {
  const modes = useApprovalModes(current)
  const deployment = useSettings(state => state.settings?.approval_mode)

  useEffect(() => {
    if (!useSettings.getState().settings) {
      void useSettings.getState().refresh()
    }
  }, [])

  const inherited = APPROVAL_MODES.find(mode => mode.value === deployment)?.label

  return (
    <Group label="Mode">
      <CheckRow
        checked={current === 'inherit'}
        onPress={() => onPick('inherit')}
        subtitle={inherited ? `Use the mode set in Settings, now ${inherited}.` : 'Use the mode set in Settings.'}
        testID="approval-inherit"
        title="Inherit"
      />
      {modes.map(mode => (
        <CheckRow
          checked={current === mode.value}
          key={mode.value}
          onPress={() => onPick(mode.value)}
          subtitle={mode.description}
          testID={`approval-${mode.label.toLowerCase()}`}
          title={mode.label}
        />
      ))}
    </Group>
  )
}
