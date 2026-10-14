import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import type { Rpc } from './types'

/**
 * Lets the daemon wake this phone when the primary bot messages from a
 * check-in. The push goes through Hex Connect and carries no message text,
 * only the bot's name and the section to open. Skipped without an EAS
 * project, where Expo cannot issue a token, and when the user says no.
 */
/** Daemon device and token pairs already sent this run of the app. */
const registered = new Set<string>()
export async function registerPush(rpc: Rpc, device = ''): Promise<void> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)
    ?.eas?.projectId
  if (!projectId) return
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
    // A daemon from before check-ins has no such method; there is nothing to register with.
    if (!/unknown method|method not found/i.test(String((error as Error)?.message ?? error)))
      throw error
  }
}

/** What a tapped check-in notification opens: a section, on the saved daemon this phone is `device` of. */
export interface PushTarget {
  section: string
  device: string | null
}
export function notificationTarget(data: unknown): PushTarget | null {
  const { section, device } = (data ?? {}) as { section?: unknown; device?: unknown }
  if (typeof section !== 'string' || !section) return null
  return { section, device: typeof device === 'string' && device ? device : null }
}
