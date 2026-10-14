import * as Notifications from 'expo-notifications'
import { notificationSection } from './push'

// A check-in that arrives while the app is open still shows its banner.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false
  })
})

/** The section the last tapped check-in notification opens, keyed by that notification. */
export function useTappedSection(): { key: string; section: string } | null {
  const response = Notifications.useLastNotificationResponse()
  const request = response?.notification.request
  const section = notificationSection(request?.content.data)
  return request && section ? { key: request.identifier, section } : null
}
