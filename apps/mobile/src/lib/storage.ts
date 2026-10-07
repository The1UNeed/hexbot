/**
 * Persistence for the phone. Preferences and drafts go to AsyncStorage
 * through zustand's `persist`; the connection target holds the device token,
 * so it lives in the iOS Keychain (Android Keystore) through SecureStore.
 */

import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { createJSONStorage } from 'zustand/middleware'

export const persistStorage = createJSONStorage(() => AsyncStorage)

export async function readSecure<T>(key: string): Promise<null | T> {
  try {
    const raw = await SecureStore.getItemAsync(key)

    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

export async function writeSecure(key: string, value: unknown): Promise<void> {
  try {
    if (value === null || value === undefined) {
      await SecureStore.deleteItemAsync(key)
    } else {
      await SecureStore.setItemAsync(key, JSON.stringify(value))
    }
  } catch {
    // Losing the saved target only means pairing again.
  }
}
