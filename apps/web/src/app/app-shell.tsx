import { useParams } from '@tanstack/react-router'
import { PanelLeft } from 'lucide-react'
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react'

import { cn } from '../lib/cn'
import { useUi } from '../stores/ui'

import { ThreadPanel } from './panel/thread'
import { ConversationColumn, ProfilePanel, RosterColumn } from './slots'

/** The canvas gutter between the cards, and the panel's exit time in ms. */
const GUTTER = 8
const PANEL_MOTION = 240

export function AppShell({ children }: { children?: ReactNode }) {
  const [panelWidth, setPanelWidth] = useState(320)
  const [mobileRosterOpen, setMobileRosterOpen] = useState(false)
  const [resizing, setResizing] = useState(false)
  const sidebarWidth = useUi(state => state.sidebarWidth)
  const setSidebarWidth = useUi(state => state.setSidebarWidth)
  const panelOpen = useUi(state => state.rightPanelOpen)
  const togglePanel = useUi(state => state.toggleRightPanel)
  const thread = useUi(state => state.thread)
  const closeThread = useUi(state => state.closeThread)
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 1100px)').matches)
  const params = useParams({ strict: false }) as { bot?: string; room?: string; section?: string }
  const roomMode = Boolean(params.room)
  // The thread panel takes the same slot as the profile, in rooms too, and goes first.
  const showThread = Boolean(thread) && !children
  const showPanel = showThread || (panelOpen && !roomMode && !children)

  // The panel stays in the tree for one beat after it closes, so it can slide
  // out while its column shrinks instead of vanishing.
  const [panelMounted, setPanelMounted] = useState(showPanel)

  useEffect(() => {
    if (showPanel) {
      setPanelMounted(true)

      return
    }

    const timer = window.setTimeout(() => setPanelMounted(false), PANEL_MOTION)

    return () => window.clearTimeout(timer)
  }, [showPanel])

  useEffect(() => {
    const media = window.matchMedia('(max-width: 1100px)')

    const change = () => {
      setCompact(media.matches)

      if (media.matches) {
        togglePanel(false)
      }
    }

    change()
    media.addEventListener('change', change)

    return () => media.removeEventListener('change', change)
  }, [togglePanel])

  useEffect(() => setMobileRosterOpen(false), [params.bot, params.room, params.section])
  // A thread belongs to the chat it was opened from; leaving that chat closes it.
  useEffect(() => closeThread(), [closeThread, params.bot, params.room, params.section])

  const panel =
    thread && showThread ? (
      <ThreadPanel key={`${thread.bot}/${thread.peer}`} thread={thread} />
    ) : (
      <ProfilePanel />
    )

  const resize = (side: 'left' | 'right', start: number) => (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    const initial = side === 'left' ? sidebarWidth : panelWidth
    setResizing(true)

    const move = (next: PointerEvent) => {
      const delta = next.clientX - start

      if (side === 'left') {
        setSidebarWidth(initial + delta)
      } else {
        setPanelWidth(Math.max(300, Math.min(520, initial - delta)))
      }
    }

    const up = () => {
      setResizing(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // The handles sit in the gutters between the cards; a hairline shows on hover.
  const handle = 'group relative -mx-[3px] w-[6px] cursor-col-resize hex-no-drag'

  const handleLine =
    'absolute inset-y-6 left-[2px] w-px rounded-full bg-transparent transition-colors group-hover:bg-foreground/20'

  // The conversation and the panel are cards on the window's canvas.
  const card =
    'my-2 min-w-0 overflow-hidden rounded-[22px] max-[700px]:m-0 max-[700px]:rounded-none'

  // The panel's track holds the panel and its gutter; closed, only the gutter
  // remains, so the chat keeps its right margin and the track can animate.
  const panelTrack = showPanel && !compact ? panelWidth + GUTTER : GUTTER

  return (
    <main
      className="relative grid h-screen overflow-hidden bg-canvas text-foreground [grid-template-columns:var(--hex-app-columns)] max-[700px]:grid-cols-1"
      style={
        {
          '--hex-app-columns': `${sidebarWidth}px 0px minmax(0,1fr) ${panelTrack}px`,
          transition: resizing
            ? undefined
            : `grid-template-columns var(--hex-motion-panel) var(--hex-ease-in-out)`
        } as CSSProperties
      }
    >
      <button
        aria-expanded={mobileRosterOpen}
        aria-label="Show roster"
        className="hex-glass hex-glass-press hex-focus hex-no-drag absolute top-2.5 left-3 z-40 hidden size-9 place-items-center rounded-full text-foreground/70 hover:text-foreground max-[700px]:grid"
        onClick={() => setMobileRosterOpen(true)}
        type="button"
      >
        <PanelLeft size={16} />
      </button>
      {mobileRosterOpen ? (
        <button
          aria-label="Hide roster"
          className="hex-fade fixed inset-0 z-40 hidden bg-black/25 backdrop-blur-sm max-[700px]:block"
          onClick={() => setMobileRosterOpen(false)}
          type="button"
        />
      ) : null}
      <aside
        className={cn(
          'min-w-0 overflow-hidden max-[700px]:fixed max-[700px]:inset-y-2 max-[700px]:left-2 max-[700px]:z-50 max-[700px]:w-[min(86vw,320px)] max-[700px]:rounded-[22px] max-[700px]:bg-canvas max-[700px]:shadow-popup max-[700px]:transition-transform max-[700px]:duration-[var(--hex-motion-panel)] max-[700px]:ease-[var(--hex-ease-out)]',
          mobileRosterOpen
            ? 'max-[700px]:translate-x-0'
            : 'max-[700px]:invisible max-[700px]:-translate-x-full'
        )}
        data-testid="app-roster"
      >
        <RosterColumn />
      </aside>
      <div
        aria-label="Resize roster"
        className={cn(handle, 'max-[700px]:hidden')}
        onPointerDown={event => resize('left', event.clientX)(event)}
        role="separator"
      >
        <span className={handleLine} />
      </div>
      <section className={cn(card, 'bg-background shadow-card')}>
        {children ?? <ConversationColumn />}
      </section>
      <div className="relative flex min-w-0 justify-end overflow-hidden max-[700px]:hidden">
        {panelMounted && !compact ? (
          <>
            <div
              aria-label={showThread ? 'Resize conversation' : 'Resize profile'}
              className={cn(handle, 'absolute inset-y-0 left-[5px] z-10')}
              onPointerDown={event => resize('right', event.clientX)(event)}
              role="separator"
            >
              <span className={handleLine} />
            </div>
            <aside
              className={cn(
                card,
                'hex-glass-strong mr-2 ml-2 shrink-0 transition-opacity duration-[var(--hex-motion-panel)]',
                showPanel ? 'opacity-100' : 'opacity-0'
              )}
              style={{ width: panelWidth }}
            >
              {panel}
            </aside>
          </>
        ) : null}
      </div>
      {panelMounted && compact ? (
        <aside
          className={cn(
            card,
            'hex-glass-strong fixed inset-y-2 right-2 z-40 w-[min(92vw,360px)] max-[700px]:inset-y-2 max-[700px]:rounded-[22px]',
            showPanel ? 'hex-slide-in' : 'hex-slide-out'
          )}
        >
          {panel}
        </aside>
      ) : null}
    </main>
  )
}
