import { useParams } from '@tanstack/react-router'
import { PanelLeft } from 'lucide-react'
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react'

import { cn } from '../lib/cn'
import { useUi } from '../stores/ui'

import { ConversationColumn, ProfilePanel, RosterColumn } from './slots'

export function AppShell({ children }: { children?: ReactNode }) {
  const [panelWidth, setPanelWidth] = useState(320)
  const [mobileRosterOpen, setMobileRosterOpen] = useState(false)
  const sidebarWidth = useUi(state => state.sidebarWidth)
  const setSidebarWidth = useUi(state => state.setSidebarWidth)
  const panelOpen = useUi(state => state.rightPanelOpen)
  const togglePanel = useUi(state => state.toggleRightPanel)
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 1100px)').matches)
  const params = useParams({ strict: false }) as { bot?: string; room?: string; section?: string }
  const roomMode = Boolean(params.room)
  const showPanel = panelOpen && !roomMode && !children

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

  const resize = (side: 'left' | 'right', start: number) => (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    const initial = side === 'left' ? sidebarWidth : panelWidth

    const move = (next: PointerEvent) => {
      const delta = next.clientX - start

      if (side === 'left') {
        setSidebarWidth(initial + delta)
      } else {
        setPanelWidth(Math.max(300, Math.min(520, initial - delta)))
      }
    }

    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const handle = 'group relative -mx-[3px] w-[6px] cursor-col-resize hex-no-drag'

  const handleLine =
    'absolute inset-y-0 left-[2px] w-px bg-border transition-colors group-hover:bg-foreground/30'

  return (
    <main
      className="relative grid h-screen overflow-hidden bg-background text-foreground [grid-template-columns:var(--hex-app-columns)] max-[700px]:grid-cols-1"
      style={
        {
          '--hex-app-columns': `${sidebarWidth}px 0px minmax(0,1fr)${showPanel && !compact ? ` 0px ${panelWidth}px` : ''}`
        } as CSSProperties
      }
    >
      <button
        aria-expanded={mobileRosterOpen}
        aria-label="Show roster"
        className="hex-no-drag absolute top-2 left-2 z-30 hidden size-7 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-foreground max-[700px]:grid"
        onClick={() => setMobileRosterOpen(true)}
        type="button"
      >
        <PanelLeft size={16} />
      </button>
      {mobileRosterOpen ? (
        <button
          aria-label="Hide roster"
          className="fixed inset-0 z-40 hidden bg-black/40 max-[700px]:block"
          onClick={() => setMobileRosterOpen(false)}
          type="button"
        />
      ) : null}
      <aside
        className={cn(
          'min-w-0 overflow-hidden bg-surface max-[700px]:fixed max-[700px]:inset-y-0 max-[700px]:left-0 max-[700px]:z-50 max-[700px]:w-[min(88vw,320px)] max-[700px]:shadow-popup max-[700px]:transition-transform',
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
      <section className="min-w-0 overflow-hidden">{children ?? <ConversationColumn />}</section>
      {showPanel ? (
        <>
          <div
            aria-label="Resize profile"
            className={cn(handle, 'max-[1100px]:hidden')}
            onPointerDown={event => resize('right', event.clientX)(event)}
            role="separator"
          >
            <span className={handleLine} />
          </div>
          <aside className="hex-fade min-w-0 overflow-hidden bg-surface max-[1100px]:fixed max-[1100px]:inset-y-0 max-[1100px]:right-0 max-[1100px]:z-40 max-[1100px]:w-[min(92vw,360px)] max-[1100px]:shadow-popup">
            <ProfilePanel />
          </aside>
        </>
      ) : null}
    </main>
  )
}
