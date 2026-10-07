import { BotPage } from '../../../components/bot/page'
import { Group, SwitchRow, TextFieldRow } from '../../../components/list'
import type { BotTool } from '../../../lib/types'

const GROUPS: { rows: { key: BotTool; subtitle: string; title: string }[]; title: string }[] = [
  {
    rows: [
      { key: 'terminal', subtitle: 'Run commands in a sandbox. Leaving it asks first, except in Bypass.', title: 'Terminal' },
      { key: 'files', subtitle: 'Read, write and search files in the workspace.', title: 'Files' },
      { key: 'code_execution', subtitle: 'Run scripts in a sandbox for data work and quick checks.', title: 'Code execution' },
      { key: 'browser', subtitle: 'Drive a local Chrome window.', title: 'Browser' },
      { key: 'computer_use', subtitle: 'See the screen and click. Needs the cua driver on the computer.', title: 'Computer use' }
    ],
    title: 'Computer'
  },
  {
    rows: [
      { key: 'vision', subtitle: 'Look at images you attach.', title: 'Vision' },
      { key: 'voice', subtitle: 'Speak replies with the built-in voice. Premium voice is a connector.', title: 'Voice' }
    ],
    title: 'Senses'
  },
  {
    rows: [
      { key: 'message_bots', subtitle: 'Ask your other bots for help, one to one.', title: 'Message other bots' },
      { key: 'delegate', subtitle: 'Hand a subtask to a copy of itself.', title: 'Delegate' },
      { key: 'scheduling', subtitle: 'Create reminders and recurring jobs.', title: 'Scheduling' }
    ],
    title: 'Working with others'
  }
]

export default function Tools() {
  return (
    <BotPage lead="What this bot can do on the computer it runs on. Nothing here needs an account." title="Tools">
      {({ bot, quietly }) => {
        const tools = Array.isArray(bot.tools) ? bot.tools : []

        return (
          <>
            {GROUPS.map(group => (
              <Group key={group.title} label={group.title}>
                {group.rows.map(row => (
                  <SwitchRow
                    key={row.key}
                    onValueChange={on => quietly({ tools: on ? [...tools.filter(tool => tool !== row.key), row.key] : tools.filter(tool => tool !== row.key) })}
                    subtitle={row.subtitle}
                    testID={`tool-${row.key}`}
                    title={row.title}
                    value={tools.includes(row.key)}
                  />
                ))}
              </Group>
            ))}
            <Group footer="Where its files and commands start. Empty means the deployment workspace." label="Workspace">
              <TextFieldRow
                autoCapitalize="none"
                autoCorrect={false}
                label="Folder"
                onCommit={async value => quietly({ workdir: value.trim() || null })}
                placeholder="Deployment workspace"
                testID="tool-workdir"
                value={bot.workdir ?? ''}
              />
            </Group>
          </>
        )
      }}
    </BotPage>
  )
}
