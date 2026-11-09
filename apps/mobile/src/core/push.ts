import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import { Linking, Platform } from 'react-native'
import type { Rpc } from './types'

/**
 * Lets the daemon wake this phone when a bot's heartbeat posts in its chat, or
 * a reply in a bot's chat is still unread a while after it finished.
 * The push goes through Hex Connect and carries no message text, only the
 * chat to open. Skipped without an EAS project, where Expo cannot issue a
 * token, and when the user says no.
 */
/** The Android channel bot messages use; Connect names it in each push. Kept from check-ins. */
export const CHANNEL = 'checkins'
/** Daemon device and token pairs already sent this run of the app. */
const registered = new Set<string>()
/** Expo issues push tokens only to a build with an EAS project, and only on a phone. */
function pushProject(): string | undefined {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return undefined
  return (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas
    ?.projectId
}
export async function registerPush(rpc: Rpc, device = ''): Promise<void> {
  const projectId = pushProject()
  if (!projectId) return
  // Android 13 asks for permission only once a channel exists, and pushes name it.
  if (Platform.OS === 'android')
    await Notifications.setNotificationChannelAsync(CHANNEL, {
      name: 'Bot messages',
      importance: Notifications.AndroidImportance.HIGH
    })
  let { status } = await Notifications.getPermissionsAsync()
  if (status === 'undetermined') status = (await Notifications.requestPermissionsAsync()).status
  if (status !== 'granted') return
  const { data } = await Notifications.getExpoPushTokenAsync({ projectId })
  // Reconnecting sends it again only when the token changed.
  const key = `${device}\n${data}`
  if (registered.has(key)) return
  try {
    await rpc('hexbot.devices.set_push', { token: data, platform: Platform.OS })
    registered.add(key)
  } catch (error) {
    // A daemon from before phone pushes has no such method; there is nothing to register with.
    if (!/unknown method|method not found/i.test(String((error as Error)?.message ?? error)))
      throw error
  }
}

/** What a tapped bot message notification opens: a section, on the saved daemon this phone is `device` of. */
export interface PushTarget {
  section: string
  device: string | null
}
export function notificationTarget(data: unknown): PushTarget | null {
  const { section, device } = (data ?? {}) as { section?: unknown; device?: unknown }
  if (typeof section !== 'string' || !section) return null
  return { section, device: typeof device === 'string' && device ? device : null }
}

/**
 * Whether this phone shows Hexbot's notifications: the system's answer, or
 * `unavailable` on the web and in a build that cannot take pushes. `canAsk`
 * is false once the system no longer shows its prompt; only its Settings can
 * turn them on then.
 */
export type PushPermission = 'denied' | 'granted' | 'unavailable' | 'undetermined'
export async function pushPermission(): Promise<{ status: PushPermission; canAsk: boolean }> {
  if (!pushProject()) return { status: 'unavailable', canAsk: false }
  const { status, canAskAgain } = await Notifications.getPermissionsAsync()
  return { status: status as PushPermission, canAsk: canAskAgain !== false }
}

/**
 * Turns notifications on for this phone: the system's prompt while it still
 * shows one, else its Settings for Hexbot. Granted, the daemon learns this
 * phone's token.
 */
export async function allowPush(rpc: Rpc, device = ''): Promise<PushPermission> {
  const { status, canAsk } = await pushPermission()
  if (status === 'unavailable' || status === 'granted') {
    if (status === 'granted') await registerPush(rpc, device)
    return status
  }
  if (!canAsk) {
    await Linking.openSettings()
    return status
  }
  const asked = (await Notifications.requestPermissionsAsync()).status as PushPermission
  if (asked === 'granted') await registerPush(rpc, device)
  return asked
}

/** One notification on this phone now, to show they work. */
export async function testNotification(): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Notifications are on',
      body: 'You will see one like this when a bot replies or needs you.'
    },
    trigger: null
  })
}
