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

/** Older daemons reject Bypass for members; keep a stored selection visible. */
export function approvalModes(role: 'admin' | 'member' | undefined, current: string | undefined) {
  return APPROVAL_MODES.filter(
    mode => role !== 'member' || mode.value !== 'off' || current === 'off'
  )
}
