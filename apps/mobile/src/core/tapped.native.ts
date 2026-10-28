import * as Notifications from 'expo-notifications'
import { notificationTarget, type PushTarget } from './push'

// A bot message that arrives while the app is open still shows its banner.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false
  })
})

/** What the last tapped bot message notification opens, keyed by that notification. */
export function useTappedSection(): (PushTarget & { key: string }) | null {
  const response = Notifications.useLastNotificationResponse()
  const request = response?.notification.request
  const target = notificationTarget(request?.content.data)
  return request && target ? { ...target, key: request.identifier } : null
}

/** Forget a handled tap, so a reload does not open it again. */
export function clearTapped(): void {
  void Notifications.clearLastNotificationResponseAsync().catch(() => undefined)
}
