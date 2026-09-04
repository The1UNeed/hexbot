import { useParams } from '@tanstack/react-router'
import { useState } from 'react'

import { useUi } from '../stores/ui'

import { ConversationColumn, ProfilePanel, RosterColumn } from './slots'

export function AppShell() {
  const [panelWidth, setPanelWidth] = useState(320)
  const sidebarWidth = useUi(state => state.sidebarWidth)
  const setSidebarWidth = useUi(state => state.setSidebarWidth)
  const panelOpen = useUi(state => state.rightPanelOpen)
  const roomMode = Boolean((useParams({ strict: false }) as { room?: string }).room)
  const showPanel = panelOpen && !roomMode

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
      className="grid h-screen overflow-hidden bg-background text-foreground"
      style={{
        gridTemplateColumns: `${sidebarWidth}px 0px minmax(480px,1fr)${showPanel ? ` 0px ${panelWidth}px` : ''}`
      }}
    >
      <aside className="min-w-0 overflow-hidden bg-surface">
        <RosterColumn />
      </aside>
      <div
        aria-label="Resize roster"
        className={handle}
        onPointerDown={event => resize('left', event.clientX)(event)}
        role="separator"
      >
        <span className={handleLine} />
      </div>
      <section className="min-w-0 overflow-hidden">
        <ConversationColumn />
      </section>
      {showPanel ? (
        <>
          <div
            aria-label="Resize profile"
            className={handle}
            onPointerDown={event => resize('right', event.clientX)(event)}
            role="separator"
          >
            <span className={handleLine} />
          </div>
          <aside className="hex-fade min-w-0 overflow-hidden bg-surface">
            <ProfilePanel />
          </aside>
        </>
      ) : null}
    </main>
  )
}
