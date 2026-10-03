import { useState } from 'react'

import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import type { Bot } from '../../lib/types'

import { Group, Heading, Row } from './shared'

export function AdvancedTab({ bot, onDelete }: { bot: Bot; onDelete: () => Promise<void> }) {
  return (
    <div>
      <Heading description="Actions that cannot be undone.">Advanced</Heading>
      <DeleteBot bot={bot} onDelete={onDelete} />
    </div>
  )
}

export function DeleteBot({ bot, onDelete }: { bot: Bot; onDelete: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)

  return (
    <Group title="Danger zone">
      <Row
        control={
          confirming ? undefined : (
            <Button onClick={() => setConfirming(true)} size="sm" variant="danger">
              Delete
            </Button>
          )
        }
        description="Removes the bot, every section, and its memory."
        title="Delete bot"
      />
      {confirming ? (
        <div className="hex-fade space-y-3 px-4 py-4">
          <p className="text-[length:var(--text-secondary)]">
            Type <strong className="font-semibold">{bot.name}</strong> to delete this bot and all of
            its sections.
          </p>
          <Input
            aria-label="Confirm bot name"
            autoFocus
            onChange={event => setTyped(event.target.value)}
            value={typed}
          />
          <div className="flex gap-2">
            <Button
              disabled={typed !== bot.name}
              onClick={() =>
                void onDelete().catch(cause =>
                  setError(cause instanceof Error ? cause.message : String(cause))
                )
              }
              variant="danger"
            >
              Delete permanently
            </Button>
            <Button
              onClick={() => {
                setConfirming(false)
                setTyped('')
              }}
              variant="ghost"
            >
              Cancel
            </Button>
          </div>
          {error ? (
            <p className="text-[length:var(--text-secondary)] text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </Group>
  )
}
