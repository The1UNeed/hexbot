import { useState } from 'react'

import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { cn } from '../../lib/cn'
import type { Bot } from '../../lib/types'

import { cardClass, Heading } from './shared'

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

  if (!confirming) {
    return (
      <div className={cn(cardClass, 'flex items-center justify-between gap-3 px-3 py-2.5')}>
        <span>
          <span className="block font-medium">Delete bot</span>
          <span className="block text-[length:var(--text-secondary)] text-muted">
            Removes the bot, every section, and its memory.
          </span>
        </span>
        <Button onClick={() => setConfirming(true)} size="sm" variant="danger">
          Delete
        </Button>
      </div>
    )
  }

  return (
    <div className={cn(cardClass, 'space-y-3 p-3')}>
      <p className="text-[length:var(--text-secondary)]">
        Type <strong>{bot.name}</strong> to delete this bot and all of its sections.
      </p>
      <Input
        aria-label="Confirm bot name"
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
  )
}
