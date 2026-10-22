/**
 * Asks before installing a downloaded app update. Yes quits and installs it;
 * the app reopens on the new version. Downloading does not ask.
 */

import { ConfirmDialog } from '../components/ui/confirm'
import { updateAction, type UpdateState } from '../lib/bridge'

/** The downloaded version an install would move to, if there is one. */
export function installTarget(state: null | UpdateState): null | string {
  return state && updateAction(state) === 'install' ? state.downloadedVersion : null
}

export function ConfirmUpdate({
  onClose,
  onConfirm,
  version
}: {
  onClose: () => void
  onConfirm: () => void
  version: null | string
}) {
  return (
    <ConfirmDialog
      detail="Hexbot quits, installs the update, and reopens. Bots stop until it is back."
      onAnswer={yes => {
        onClose()

        if (yes) {
          onConfirm()
        }
      }}
      open={version !== null}
      title={`Are you sure you want to update to version ${version}?`}
    />
  )
}
