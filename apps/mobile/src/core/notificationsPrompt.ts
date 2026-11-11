import AsyncStorage from '@react-native-async-storage/async-storage'
import { useCallback, useEffect, useState } from 'react'
import { AppState } from 'react-native'

import { allowPush, type PushPermission, pushPermission } from './push'
import type { Rpc } from './types'

/** Closed with its ✕: this phone is not asked again. Settings, Notifications still turns them on. */
const KEY = 'hexbot.notifications.prompt'

/**
 * The "Turn on notifications" banner over the chat list, while this phone
 * does not show Hexbot's notifications. Checked again whenever the app comes
 * back, so turning them on in the system's Settings hides it.
 */
export function useNotificationsPrompt(rpc: Rpc, device: string | undefined, connected: boolean) {
  const [status, setStatus] = useState<PushPermission>('unavailable')
  const [closed, setClosed] = useState(true)

  const check = useCallback(() => {
    // Storage or the system may refuse; the banner then stays away.
    void Promise.resolve()
      .then(pushPermission)
      .then(
        result => setStatus(result.status),
        () => setStatus('unavailable')
      )
  }, [])

  useEffect(() => {
    void Promise.resolve()
      .then(() => AsyncStorage.getItem(KEY))
      .then(
        value => setClosed(value === 'closed'),
        () => setClosed(false)
      )
    check()
    const listener = AppState.addEventListener('change', state => {
      if (state === 'active') check()
    })
    return () => listener.remove()
  }, [check])

  const visible = connected && !closed && (status === 'denied' || status === 'undetermined')

  return visible
    ? {
        onEnable: () => {
          void Promise.resolve()
            .then(() => allowPush(rpc, device))
            .then(setStatus, check)
        },
        onClose: () => {
          setClosed(true)
          void Promise.resolve()
            .then(() => AsyncStorage.setItem(KEY, 'closed'))
            .catch(() => undefined)
        }
      }
    : null
}
