import { useUsers } from '../stores/users'

import type { ApprovalMode } from './types'

/** The approval modes, strictest first. The daemon calls Auto `smart` and Bypass `off`. */
export const APPROVAL_MODES: { description: string; label: string; value: ApprovalMode }[] = [
  {
    description:
      'Ask before every file change and code run. Commands run read-only, without internet access.',
    label: 'Manual',
    value: 'manual'
  },
  {
    description:
      'Work freely in the workspace. Commands run without internet access, and anything outside the workspace asks first.',
    label: 'Auto',
    value: 'smart'
  },
  {
    description:
      'Never ask and use no sandbox. Bots can read and change anything on this computer.',
    label: 'Bypass',
    value: 'off'
  }
]

/**
 * Bypass can read the admin's provider keys, so the daemon offers it to the
 * admin only. A mode already in use stays listed so the control shows it.
 */
export function useApprovalModes(current?: null | string) {
  const admin = useUsers(state => state.supported === false || state.current?.role === 'admin')

  return APPROVAL_MODES.filter(mode => mode.value !== 'off' || admin || current === 'off')
}
