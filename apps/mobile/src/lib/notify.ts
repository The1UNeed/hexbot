/**
 * In-app notices. A phone app only holds its socket while it is open, so the
 * transcript store's "bot needs you / finished" notifications become a
 * banner at the top of the screen plus a haptic tap. `components/banner.tsx`
 * renders the newest one.
 */

import * as Haptics from 'expo-haptics'
import { create } from 'zustand'

export interface Notice {
  body: string
  id: number
  sectionId?: string
  title: string
}

interface NoticeState {
  dismiss: (id: number) => void
  notice: Notice | null
}

let nextId = 1

export const useNotice = create<NoticeState>(set => ({
  notice: null,

  dismiss(id) {
    set(state => (state.notice?.id === id ? { notice: null } : state))
  }
}))

export function notifyLocal(input: { body: string; sectionId?: string; title: string }): void {
  useNotice.setState({ notice: { ...input, id: nextId++ } })
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined)
}
