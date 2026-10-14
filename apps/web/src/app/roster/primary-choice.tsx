import { useState } from 'react'

import { Button } from '../../components/ui/button'
import { Select } from '../../components/ui/select'
import { botsCreatePrimary, botsSetPrimary, sectionsCreate } from '../../lib/api'
import { avatarPng, styleForName } from '../../lib/avatar-builder'
import type { Bot, Section } from '../../lib/types'
import { botsActions } from '../../stores/bots'

/** The handle `hexbot.bots.create_primary` gives HexBot. */
const PRIMARY_HANDLE = 'hexbot'

/**
 * An install from before the primary bot asks the user to add HexBot or to
 * make one of their bots primary. Shown until there is one; a daemon that
 * predates it leaves `primary` out, so nothing is shown there.
 */
export function needsPrimary(bots: Bot[]): boolean {
  return bots.length > 0 && bots.every(bot => bot.primary === false)
}

export function PrimaryChoice({
  bots,
  onCreated
}: {
  bots: Bot[]
  /**
   * Opens the primary bot's new section. `created` is false for a promoted
   * bot, whose older sections lack the new tools and which needs no greeting.
   */
  onCreated: (bot: Bot, section: Section, created: boolean) => void
}) {
  // A bot already called hexbot can only be promoted, so it is offered first.
  const taken = bots.some(bot => bot.name === PRIMARY_HANDLE)
  const [chosen, setChosen] = useState(taken ? PRIMARY_HANDLE : '')
  const [busy, setBusy] = useState<'add' | 'promote' | null>(null)
  const [error, setError] = useState<null | string>(null)

  const run = async (kind: 'add' | 'promote') => {
    setBusy(kind)
    setError(null)

    try {
      if (kind === 'add') {
        const avatar = await avatarPng(styleForName(PRIMARY_HANDLE))
        const { bot, section } = await botsCreatePrimary(avatar ? { avatar } : {})
        await botsActions().refresh()
        onCreated(bot, section, true)
      } else {
        const { bot } = await botsSetPrimary(chosen)
        const { section } = await sectionsCreate(bot.name)
        await botsActions().refresh()
        onCreated(bot, section, false)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section
      aria-labelledby="primary-choice-title"
      className="mb-2 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 rounded-panel bg-surface-2/60 p-3"
      data-testid="primary-choice"
    >
      <div className="grid gap-1">
        <h2 className="font-semibold" id="primary-choice-title">
          Choose a primary bot
        </h2>
        <p className="text-[length:var(--text-secondary)] text-muted">
          It sets up and looks after your other bots, rooms, scheduled jobs and settings. There is
          only one, and it can't be deleted.
        </p>
      </div>
      {taken ? null : (
        <Button
          busy={busy === 'add'}
          disabled={busy !== null}
          onClick={() => void run('add')}
          variant="primary"
        >
          Add HexBot
        </Button>
      )}
      <div className="grid min-w-0 gap-2">
        <div className="min-w-0">
          <Select
            label="Bot to make primary"
            onValueChange={setChosen}
            options={bots.map(bot => ({ label: bot.display_name, value: bot.name }))}
            placeholder="One of your bots"
            value={chosen || undefined}
          />
        </div>
        <Button
          busy={busy === 'promote'}
          disabled={!chosen || busy !== null}
          onClick={() => void run('promote')}
        >
          Make primary
        </Button>
      </div>
      {error ? (
        <p className="text-[length:var(--text-secondary)] text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}
