/**
 * The bar every change to the plugins table passes through: what waits, a
 * review in plain sentences, and Undo for what was applied last.
 */

import { Check, ChevronRight, TriangleAlert, X } from 'lucide-react'
import { Children, useMemo, useRef } from 'react'

import { Button } from '../../../components/ui/button'
import { ConnectorIcon } from '../../../components/ui/connector-icon'
import { Dialog } from '../../../components/ui/dialog'
import { cn } from '../../../lib/cn'
import { changesOf, changeWho, columnText, count, listed } from '../../../lib/plugin-access'
import { usePluginAccess } from '../../../stores/plugin-access'

import type { AccessData } from './data'

export function ChangeBar({
  children,
  data,
  hint
}: {
  children?: React.ReactNode
  data: AccessData
  hint: string
}) {
  const last = usePluginAccess(state => state.last)
  const busy = usePluginAccess(state => state.busy)
  const error = usePluginAccess(state => state.error)
  const apply = usePluginAccess(state => state.apply)
  const discard = usePluginAccess(state => state.discard)
  const undo = usePluginAccess(state => state.undo)
  const reviewing = usePluginAccess(state => state.reviewing)
  const setReviewing = usePluginAccess(state => state.setReviewing)
  const { access, bots, flips, groups, unstage } = data
  const changes = useMemo(() => changesOf(flips, access, bots, groups), [access, bots, flips, groups])
  const changed = new Set(flips.map(flip => flip.bot)).size
  const summary = `${count(changes.length, 'change')} for ${count(changed, 'bot')}`
  const root = useRef<HTMLElement | null>(null)

  // Applying, undoing and discarding remove the button that was pressed, so
  // focus moves to what took its place instead of falling to the page.
  const refocus = () =>
    setTimeout(() => {
      const bar = root.current

      ;(bar?.querySelector<HTMLElement>('[data-after]') ?? bar)?.focus()
    }, 80)

  // Read out by screen readers. It stays mounted so the first change is announced too.
  const live = (
    <span aria-live="polite" className="sr-only" role="status">
      {busy
        ? 'Applying.'
        : flips.length
          ? `${summary}, not applied yet.`
          : last
            ? `Applied ${last.text}.`
            : ''}
    </span>
  )

  // With nothing waiting and nothing to undo there is no bar, only the line of help.
  const bar = Boolean(flips.length || last || Children.toArray(children).length || error)

  return (
    <>
      {live}
      <p
        className="hex-focus mt-3 rounded-[6px] px-1 text-[length:var(--text-meta)] text-muted"
        ref={element => {
          if (!bar) {
            root.current = element
          }
        }}
        tabIndex={-1}
      >
        {hint}
      </p>
      {bar ? (
        <div
          className="hex-focus hex-rise sticky bottom-10 z-30 mt-3 flex min-h-[46px] flex-wrap items-center gap-2 rounded-[23px] bg-background py-2 pr-2 pl-4 shadow-[var(--hex-shadow-popup)]"
          data-change-bar
          ref={element => {
            if (element) {
              root.current = element
            }
          }}
          tabIndex={-1}
        >
          {children}
          <p className="min-w-[10rem] flex-1 text-[length:var(--text-secondary)]">
            {error ? (
              <span className="text-danger" role="alert">
                {error}{' '}
              </span>
            ) : null}
            {flips.length ? (
              <>
                <span className="font-medium tabular-nums">{summary}</span>, not applied yet.
              </>
            ) : last ? (
              <span className="hex-fade inline-flex items-center gap-1.5">
                <span className="grid size-[18px] shrink-0 place-items-center rounded-full bg-success text-white">
                  <Check className="hex-tick" size={11} strokeWidth={3.2} />
                </span>
                <span>
                  <span className="font-medium">Applied {last.text}.</span>{' '}
                  <span className="text-muted">Chats pick it up at the next message.</span>
                </span>
              </span>
            ) : null}
          </p>
          {flips.length ? (
            <>
              <Button
                disabled={busy}
                onClick={() => {
                  discard()
                  refocus()
                }}
                size="sm"
                variant="ghost"
              >
                Discard
              </Button>
              <Button busy={busy} onClick={() => setReviewing(true)} size="sm" variant="primary">
                Review {count(changes.length, 'change')}
              </Button>
            </>
          ) : last ? (
            <Button
              busy={busy}
              data-after
              onClick={() => {
                void undo().then(refocus)
              }}
              size="sm"
            >
              Undo
            </Button>
          ) : null}
        </div>
      ) : null}
      {reviewing && flips.length ? (
        <Dialog
          className="w-[min(540px,94vw)]"
          description="Nothing has changed yet. Take out any line you did not mean."
          onOpenChange={open => !open && !busy && setReviewing(false)}
          open
          title={`Review ${summary}`}
        >
          <div className="px-6 pt-3 pb-6">
            <ul className="divide-y divide-foreground/[0.07]">
              {changes.map(change => {
                const who = changeWho(change)
                const one = change.bots.length === 1

                const what = `${change.on ? (one ? 'gets' : 'get') : one ? 'loses' : 'lose'} ${columnText(change.column, groups)}`

                const group = groups.find(each => each.id === change.column.group)

                return (
                  <li
                    className="flex items-start gap-3 py-2.5"
                    key={`${change.on}:${change.column.key}:${change.bots[0]!.name}`}
                  >
                    <ConnectorIcon className="mt-0.5" icon={change.column.plugin.icon} />
                    <div className="min-w-0 flex-1">
                      <p>
                        <span className="font-medium">{who}</span> {what}
                      </p>
                      {one ? null : (
                        // Every bot a line stands for can be read before it is applied.
                        <details className="group text-[length:var(--text-meta)] text-muted">
                          <summary className="hex-focus inline-flex cursor-default list-none items-center gap-1 rounded-[4px] hover:text-foreground [&::-webkit-details-marker]:hidden">
                            <ChevronRight className="transition-transform group-open:rotate-90" size={12} />
                            {change.bots.length <= 4
                              ? listed(change.bots.map(bot => bot.display_name))
                              : `${listed(change.bots.slice(0, 3).map(bot => bot.display_name))} and ${change.bots.length - 3} more`}
                          </summary>
                          <p className="mt-1 pl-4">{change.bots.map(bot => bot.display_name).join(', ')}</p>
                        </details>
                      )}
                      {change.fresh && group ? (
                        <p className="mt-0.5 flex items-center gap-1 text-[length:var(--text-meta)] text-warning">
                          <TriangleAlert className="shrink-0" size={12} />
                          {one ? 'Its' : 'Their'} first plugin from {group.name}
                        </p>
                      ) : null}
                    </div>
                    <Button
                      aria-label={`Take out of the changes: ${who} ${what}`}
                      disabled={busy}
                      onClick={() =>
                        unstage(
                          change.bots.map(bot => bot.name),
                          [change.column.key]
                        )
                      }
                      size="icon"
                      variant="ghost"
                    >
                      <X size={15} />
                    </Button>
                  </li>
                )
              })}
            </ul>
            <p className={cn('mt-3 text-[length:var(--text-secondary)] text-muted')}>
              Chats pick the change up at their next message. Undo stays in the bar until the next
              change is applied.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button disabled={busy} onClick={() => setReviewing(false)} size="sm" variant="ghost">
                Keep editing
              </Button>
              <Button
                busy={busy}
                onClick={() => {
                  void apply(summary, flips).then(refocus)
                }}
                size="sm"
                variant="primary"
              >
                Apply {count(changes.length, 'change')}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </>
  )
}
