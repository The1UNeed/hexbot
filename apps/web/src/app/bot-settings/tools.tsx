import { useEffect, useState } from 'react'

import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Switch } from '../../components/ui/switch'
import type { Bot, BotTool } from '../../lib/types'

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
        description: 'Run commands in a sandbox. Leaving it asks first, except in Bypass.',
        key: 'terminal',
        label: 'Terminal',
        note: 'Sandboxed'
      },
      {
        description: 'Read, write and search files in the workspace.',
        key: 'files',
        label: 'Files'
      },
      {
        description: 'Run scripts in a sandbox for data work and quick checks.',
        key: 'code_execution',
        label: 'Code execution'
      },
      { description: 'Drive a local Chrome window.', key: 'browser', label: 'Browser' },
      {
        description: 'See the screen and click. Needs the cua driver on this computer.',
        key: 'computer_use',
        label: 'Computer use'
      }
    ],
    title: 'Computer'
  },
  {
    rows: [
      { description: 'Look at images you attach.', key: 'vision', label: 'Vision' },
      {
        description: 'Speak replies with the built-in voice. Premium voice is a connector.',
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
  })).filter(group => group.rows.length > 0)

  const [editingDir, setEditingDir] = useState(false)
  const [dir, setDir] = useState(bot.workdir ?? '')
  useEffect(() => setDir(bot.workdir ?? ''), [bot.workdir])

  const toggle = (key: BotTool, checked: boolean) =>
    void onSave({ tools: checked ? [...tools, key] : tools.filter(tool => tool !== key) })

  return (
    <div>
      <Heading description="What this bot can do on this computer. Tools this computer isn't set up for don't appear.">
        Tools
      </Heading>
      <div className="space-y-8">
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
          </Group>
        ))}
        <Group title="Workspace">
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
        </Group>
      </div>
    </div>
  )
}
