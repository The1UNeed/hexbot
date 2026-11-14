import { useEffect, useState } from 'react'

import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Switch } from '../../components/ui/switch'
import type { Bot, BotTool } from '../../lib/types'
import { computerTitle, useComputers } from '../../stores/computers'
import { useConnection } from '../../stores/connection'
import { computerLine } from '../computer-picker'

import { Group, Heading, Row, type SaveBot } from './shared'

interface ToolRow {
  description: string
  key: BotTool
  label: string
  note?: string
}

export const TOOL_GROUPS: { rows: ToolRow[]; title: string }[] = [
  {
    rows: [
      {
        description:
          "Run commands on its computers. On yours they stay in a sandbox, and leaving it is checked first, except in Bypass.",
        key: 'terminal',
        label: 'Terminal',
        note: 'Sandboxed'
      },
      {
        description: 'Read, write and search files in the workspace.',
        key: 'files',
        label: 'Files'
      }
    ],
    title: 'Workspace'
  },
  {
    rows: [
      { description: 'Look at images you attach.', key: 'vision', label: 'Vision' },
      {
        description: 'Speak replies with the built-in voice.',
        key: 'voice',
        label: 'Voice'
      }
    ],
    title: 'Senses'
  },
  {
    rows: [
      {
        description: 'Ask your other bots for help, one to one.',
        key: 'message_bots',
        label: 'Message other bots'
      },
      { description: 'Hand a subtask to a copy of itself.', key: 'delegate', label: 'Delegate' },
      {
        description: 'Create reminders and recurring jobs.',
        key: 'scheduling',
        label: 'Scheduling'
      }
    ],
    title: 'Working with others'
  }
]

export function ToolsTab({ bot, onSave }: { bot: Bot; onSave: SaveBot }) {
  const tools = Array.isArray(bot.tools) ? bot.tools : []
  const available = bot.available_tools

  const groups = TOOL_GROUPS.map(group => ({
    ...group,
    rows: available ? group.rows.filter(row => available.includes(row.key)) : group.rows
    // The working directory stays even if neither tool is set up.
  })).filter(group => group.rows.length > 0 || group.title === 'Workspace')

  const toggle = (key: BotTool, checked: boolean) =>
    void onSave({ tools: checked ? [...tools, key] : tools.filter(tool => tool !== key) })

  return (
    <div>
      <Heading description="What this bot can do here and with your other bots.">
        Tools
      </Heading>
      <div className="space-y-8">
        <BotComputers bot={bot} />
        {groups.map(group => (
          <Group key={group.title} title={group.title}>
            {group.rows.map(row => (
              <Row
                control={
                  <Switch
                    aria-label={row.label}
                    checked={tools.includes(row.key)}
                    onCheckedChange={checked => toggle(row.key, checked)}
                  />
                }
                description={row.description}
                key={row.key}
                title={
                  <span className="flex items-baseline gap-2">
                    {row.label}
                    {row.note ? (
                      <span className="text-[length:var(--text-meta)] text-muted">{row.note}</span>
                    ) : null}
                  </span>
                }
              />
            ))}
            {group.title === 'Workspace' ? <WorkdirRow bot={bot} onSave={onSave} /> : null}
          </Group>
        ))}
      </div>
    </div>
  )
}

/** The computers this bot may use, the same switches as Settings, Computers. */
function BotComputers({ bot }: { bot: Bot }) {
  const list = useComputers(state => state.list)
  const refresh = useComputers(state => state.refresh)
  const allow = useComputers(state => state.allow)
  const allowScreen = useComputers(state => state.allowScreen)
  const connects = useConnection(state => state.connects)
  useEffect(() => void refresh(), [connects, refresh])

  // An older daemon has no computers to choose.
  if (!list) {
    return null
  }

  const shown = list.computers.filter(computer => computer.on !== false)

  // Neither keeps bots off every screen.
  const daemon =
    list.choice === 'none' ? undefined : shown.find(computer => computer.kind === 'daemon')

  return (
    <Group footer="Settings, Computers chooses where all your bots work." title="Computers">
      {shown.length ? (
        shown.map(computer => (
          <Row
            control={
              <Switch
                aria-label={`Uses ${computerTitle(computer)}`}
                checked={computer.bots?.includes(bot.name) ?? false}
                onCheckedChange={allowed => void allow(computer.id, bot.name, allowed)}
              />
            }
            description={computerLine(computer)}
            key={computer.id}
            title={computerTitle(computer)}
          />
        ))
      ) : (
        <Row description="Commands are refused until you choose a computer." title="None" />
      )}
      {daemon ? (
        <Row
          control={
            <Switch
              aria-label={`Uses the screen of ${daemon.name}`}
              checked={daemon.screen_bots?.includes(bot.name) ?? false}
              onCheckedChange={screen => void allowScreen(daemon.id, bot.name, screen)}
            />
          }
          description="Sees your apps and clicks and types there. Asks first, except in Bypass."
          title={`Screen of ${daemon.name}`}
        />
      ) : null}
    </Group>
  )
}

/** Where this bot's terminal and files start. */
function WorkdirRow({ bot, onSave }: { bot: Bot; onSave: SaveBot }) {
  const [editingDir, setEditingDir] = useState(false)
  const [dir, setDir] = useState(bot.workdir ?? '')
  useEffect(() => setDir(bot.workdir ?? ''), [bot.workdir])

  return (
    <Row
      control={
        editingDir ? (
          <>
            <Button
              onClick={() => {
                setEditingDir(false)
                void onSave({ workdir: dir.trim() || null })
              }}
              size="sm"
              variant="primary"
            >
              Save
            </Button>
            <Button
              onClick={() => {
                setDir(bot.workdir ?? '')
                setEditingDir(false)
              }}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button onClick={() => setEditingDir(true)} size="sm">
            Change
          </Button>
        )
      }
      description={
        editingDir ? (
          <Input
            aria-label="Working directory"
            autoFocus
            className="mt-1.5 h-[32px] font-mono text-[length:var(--text-secondary)]"
            onChange={event => setDir(event.target.value)}
            placeholder="Deployment workspace"
            value={dir}
          />
        ) : (
          <span className="font-mono">{bot.workdir || 'Deployment workspace'}</span>
        )
      }
      title="Working directory"
    />
  )
}
