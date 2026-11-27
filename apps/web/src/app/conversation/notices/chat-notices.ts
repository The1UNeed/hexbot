import { useNavigate } from '@tanstack/react-router'
import { Bell, BellOff } from 'lucide-react'

import { getBridge } from '../../../lib/bridge'
import { systemNotificationSettings, useNotificationsPrompt } from '../../../lib/notify'
import { plainError } from '../../../lib/plain-error'
import { toMillis } from '../../../lib/time'
import type { TranscriptMessage } from '../../../stores/transcripts'
import { transcriptActions, useTranscripts } from '../../../stores/transcripts'

import type { Notice, NoticeAction } from './notice'

/** What the notice calls the computer's system when it hides notifications. */
function systemName(): string {
  const platform = getBridge()?.platform

  if (platform === 'darwin') {
    return 'macOS'
  }

  return platform === 'win32' ? 'Windows' : 'Your system'
}

/**
 * The offer to turn notifications on, once per device (`useNotificationsPrompt`).
 * Enable asks the browser; the app sends a test and asks whether it appeared.
 */
export function useNotificationsNotice(): Notice | null {
  const prompt = useNotificationsPrompt()
  const navigate = useNavigate()

  if (!prompt.visible) {
    return null
  }

  const settings = systemNotificationSettings()

  const menu = [
    {
      label: 'Notification settings',
      onSelect: () => void navigate({ params: { tab: 'notifications' }, to: '/settings/$tab' })
    },
    { label: 'Don’t ask again', onSelect: prompt.never }
  ]

  const base = {
    id: 'notifications',
    menu,
    onDismiss: prompt.close,
    tone: 'info' as const
  }

  if (prompt.step === 'check') {
    return {
      ...base,
      actions: [
        { label: 'No', onSelect: prompt.missing },
        { label: 'Yes', onSelect: prompt.confirm, primary: true }
      ],
      detail: 'Hexbot just sent one to this computer.',
      icon: Bell,
      title: 'Did a test notification appear?'
    }
  }

  if (prompt.step === 'blocked') {
    return {
      ...base,
      actions: [
        ...(settings
          ? [{ label: `Open ${settings.name}`, onSelect: settings.open, primary: true }]
          : []),
        { label: 'Try again', onSelect: () => void prompt.enable() }
      ],
      detail: settings
        ? `Allow Hexbot in ${settings.name}, then try again.`
        : 'Allow Hexbot in its notification settings, then try again.',
      icon: BellOff,
      title: `${systemName()} is not showing them`
    }
  }

  return {
    ...base,
    actions: [{ label: 'Enable', onSelect: () => void prompt.enable(), primary: true }],
    detail: 'Know when a bot replies or needs you.',
    icon: Bell,
    title: 'Turn on notifications'
  }
}

/** Connected tools that failed to start, for a chat or a room. */
export function useToolsNotice(sectionId: string): Notice | null {
  const warnings = useTranscripts(state => state.warnings)

  const entries = Object.entries(warnings).filter(
    ([key]) =>
      key === sectionId || (sectionId.startsWith('room:') && key.startsWith(`${sectionId}:`))
  )

  if (!entries.length) {
    return null
  }

  const lines = entries.flatMap(([, text]) => text.split('\n')).filter(Boolean)

  return {
    detail: lines.slice(1).join(' ') || undefined,
    id: `tools:${sectionId}`,
    onDismiss: () => entries.forEach(([key]) => transcriptActions().setWarning(key, null)),
    title: lines[0] ?? 'Some tools didn’t connect',
    tone: 'warning'
  }
}

export function waitingNotice(name?: string, onShow?: () => void): Notice {
  return {
    actions: onShow ? [{ label: 'Show', onSelect: onShow, primary: true }] : undefined,
    detail: 'Answer in the chat to keep going.',
    id: 'waiting',
    title: name ? `${name} is waiting on you` : 'Waiting on you',
    tone: 'accent'
  }
}

/** A turn that stopped, or a request that did not go through. */
export function stoppedNotice({
  message,
  name,
  connectorName,
  onDismiss,
  onFix,
  onRetry
}: {
  message: TranscriptMessage
  name: string
  connectorName?: string
  onDismiss?: () => void
  onFix?: () => void
  onRetry?: () => void
}): Notice {
  const actions: NoticeAction[] = [
    ...(onFix && connectorName
      ? [{ label: `Fix ${connectorName}`, onSelect: onFix, primary: true }]
      : []),
    ...(onRetry ? [{ label: 'Retry', onSelect: onRetry, primary: !onFix }] : [])
  ]

  return {
    actions,
    detail: plainError(message.error ?? ''),
    id: `stopped:${message.id}`,
    testId: 'stopped-card',
    onDismiss,
    time: message.createdAt > 0 ? toMillis(message.createdAt) : undefined,
    title: message.request ? "Didn't go through" : `${name} stopped`,
    tone: 'danger'
  }
}

export function loadFailureNotice(reason: string, onRetry: () => void): Notice {
  return {
    actions: [{ label: 'Retry', onSelect: onRetry, primary: true }],
    detail: plainError(reason),
    id: 'load-failure',
    testId: 'missing-messages',
    title: "This chat didn't finish loading",
    tone: 'danger'
  }
}
