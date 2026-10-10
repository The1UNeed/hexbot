import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import * as Crypto from 'expo-crypto'
import { Platform } from 'react-native'
import { bytesToHex } from '@noble/hashes/utils'
import type { SavedDaemon } from './types'
const memory = new Map<string, string>()
// The browser preview never writes credentials to localStorage.
const secret = {
  get: (key: string) =>
    Platform.OS === 'web'
      ? Promise.resolve(memory.get(key) ?? null)
      : SecureStore.getItemAsync(key),
  set: (key: string, value: string) =>
    Platform.OS === 'web'
      ? Promise.resolve(memory.set(key, value)).then(() => undefined)
      : SecureStore.setItemAsync(key, value, {
          keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
        }),
  delete: (key: string) =>
    Platform.OS === 'web'
      ? Promise.resolve(memory.delete(key)).then(() => undefined)
      : SecureStore.deleteItemAsync(key)
}
export async function proofKey(): Promise<string> {
  const key = await secret.get('hexbot.proof-key')
  if (key) return key
  const generated = bytesToHex(Crypto.getRandomBytes(32))
  await secret.set('hexbot.proof-key', generated)
  return generated
}
export async function loadDaemons(): Promise<SavedDaemon[]> {
  const data = await AsyncStorage.getItem('hexbot.daemons')
  if (!data) return []
  const parsed: unknown = JSON.parse(data)
  if (!Array.isArray(parsed)) throw new Error('Saved connections could not be read.')
  return parsed.filter(
    (v): v is SavedDaemon =>
      typeof v?.id === 'string' && typeof v?.origin === 'string' && typeof v?.name === 'string'
  )
}
export const loadToken = (id: string) => secret.get(`hexbot.device.${id}`)
export async function saveDaemon(daemon: SavedDaemon, token: string): Promise<void> {
  await secret.set(`hexbot.device.${daemon.id}`, token)
  const list = await loadDaemons()
  await AsyncStorage.setItem(
    'hexbot.daemons',
    JSON.stringify([...list.filter(d => d.id !== daemon.id), daemon])
  )
  await AsyncStorage.setItem('hexbot.active', daemon.id)
}
export async function forgetDaemon(id: string): Promise<void> {
  await secret.delete(`hexbot.device.${id}`)
  await AsyncStorage.setItem(
    'hexbot.daemons',
    JSON.stringify((await loadDaemons()).filter(d => d.id !== id))
  )
  if ((await AsyncStorage.getItem('hexbot.active')) === id)
    await AsyncStorage.removeItem('hexbot.active')
}
export const activeDaemonId = () => AsyncStorage.getItem('hexbot.active')
export const selectDaemon = (id: string) => AsyncStorage.setItem('hexbot.active', id)
export const loadConnectSession = () => secret.get('hexbot.connect-session')
export const saveConnectSession = (token: string) => secret.set('hexbot.connect-session', token)
export const clearConnectSession = () => secret.delete('hexbot.connect-session')
