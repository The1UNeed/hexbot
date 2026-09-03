import { createFileRoute } from '@tanstack/react-router'

import { ActivityView } from '../app/activity'
import { RosterColumn } from '../app/roster'
import { useUi } from '../stores/ui'

export const Route = createFileRoute('/activity')({ component: ActivityPage })

function ActivityPage() {
  const width = useUi(state => state.sidebarWidth)

  return (
    <main
      className="grid min-h-screen bg-background text-foreground"
      style={{ gridTemplateColumns: `${width}px minmax(480px,1fr)` }}
    >
      <aside className="border-r border-border">
        <RosterColumn />
      </aside>
      <ActivityView />
    </main>
  )
}
