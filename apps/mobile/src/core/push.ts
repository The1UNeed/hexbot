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
export async function registerPush(rpc: Rpc): Promise<void> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)
    ?.eas?.projectId
  if (!projectId) return
  let { status } = await Notifications.getPermissionsAsync()
  if (status === 'undetermined') status = (await Notifications.requestPermissionsAsync()).status
  if (status !== 'granted') return
  const { data } = await Notifications.getExpoPushTokenAsync({ projectId })
  try {
    await rpc('hexbot.devices.set_push', { token: data, platform: Platform.OS })
  } catch (error) {
    // A daemon from before check-ins has no such method; there is nothing to register with.
    if (!/unknown method|method not found/i.test(String((error as Error)?.message ?? error)))
      throw error
  }
}

/** The section a tapped check-in notification is about. */
export function notificationSection(data: unknown): string | null {
  const section = (data as { section?: unknown } | null | undefined)?.section
  return typeof section === 'string' && section ? section : null
}
