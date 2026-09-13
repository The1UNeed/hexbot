import { createFileRoute } from '@tanstack/react-router'

import { ActivityView } from '../app/activity'
import { AppShell } from '../app/app-shell'

export const Route = createFileRoute('/activity')({ component: ActivityPage })

function ActivityPage() {
  return (
    <AppShell>
      <div className="h-full overflow-auto max-[700px]:pt-11">
        <ActivityView />
      </div>
    </AppShell>
  )
}
