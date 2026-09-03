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

  return (
    <main
      className="grid min-h-screen bg-background text-foreground"
      style={{
        gridTemplateColumns: `${sidebarWidth}px 4px minmax(480px,1fr)${panelOpen && !roomMode ? ` 4px ${panelWidth}px` : ''}`
      }}
    >
      <aside className="min-w-0 overflow-auto border-r border-border">
        <RosterColumn />
      </aside>
      <div
        aria-label="Resize roster"
        className="cursor-col-resize"
        onPointerDown={event => resize('left', event.clientX)(event)}
        role="separator"
      />
      <section className="min-w-0 overflow-auto">
        <ConversationColumn />
      </section>
      {panelOpen && !roomMode ? (
        <>
          <div
            aria-label="Resize profile"
            className="cursor-col-resize"
            onPointerDown={event => resize('right', event.clientX)(event)}
            role="separator"
          />
          <aside className="min-w-0 overflow-auto border-l border-border">
            <ProfilePanel />
          </aside>
        </>
      ) : null}
    </main>
  )
}
