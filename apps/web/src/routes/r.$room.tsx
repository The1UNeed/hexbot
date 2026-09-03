import { createFileRoute } from '@tanstack/react-router'

import { AppShell } from '../app/app-shell'

export const Route = createFileRoute('/r/$room')({ component: AppShell })
