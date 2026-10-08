/**
 * Asks before installing a downloaded app update. Yes quits and installs it;
 * the app reopens on the new version. Downloading does not ask.
 */

import { Button } from '../components/ui/button'
import { Dialog } from '../components/ui/dialog'
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
    <Dialog
      className="w-[min(26rem,92vw)]"
      onOpenChange={open => !open && onClose()}
      open={version !== null}
      title={`Are you sure you want to update to version ${version}?`}
    >
      <div className="space-y-4 px-5 py-4">
        <p className="text-[length:var(--text-secondary)] text-muted">
          Hexbot quits, installs the update, and reopens. Bots stop until it is back.
        </p>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="ghost">
            No
          </Button>
          <Button
            onClick={() => {
              onClose()
              onConfirm()
            }}
            variant="primary"
          >
            Yes
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
