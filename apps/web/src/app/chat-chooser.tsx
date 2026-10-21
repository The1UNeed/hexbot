/**
 * Asks which section is a bot's chat on a daemon from before one chat per
 * bot, when that daemon's list cannot say (see `legacyChat`). Picking none
 * opens nothing and makes nothing.
 */

import { Dialog } from '../components/ui/dialog'
import { useBots } from '../stores/bots'
import { useSections } from '../stores/sections'

import { relativeTime } from './roster'

export function ChatChooser() {
  const choosing = useSections(state => state.choosing)

  const name = useBots(state =>
    choosing ? (state.byName[choosing.bot]?.display_name ?? choosing.bot) : ''
  )

  return (
    <Dialog
      description="This daemon keeps several conversations per bot. Pick the one to keep as your chat."
      onOpenChange={open => !open && choosing?.pick(null)}
      open={Boolean(choosing)}
      title={`Continue with ${name}`}
    >
      <ul className="grid gap-0.5 px-3 pt-2 pb-4">
        {choosing?.choices.map(section => (
          <li key={section.id}>
            <button
              className="flex w-full items-center gap-3 rounded-panel px-3 py-2.5 text-left outline-none transition-colors duration-[var(--hex-motion-fast)] hover:bg-foreground/[0.04] focus-visible:ring-1 focus-visible:ring-foreground/40"
              onClick={() => choosing.pick(section)}
              type="button"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{section.title}</span>
                {section.preview ? (
                  <span className="block truncate text-[length:var(--text-meta)] text-muted">
                    {section.preview}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-[length:var(--text-meta)] text-muted tabular-nums">
                {section.archived_at ? 'Archived' : relativeTime(section.updated_at)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  )
}
