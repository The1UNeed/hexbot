/**
 * Asks before an app update. Yes downloads the update if it is not on disk
 * yet, then quits and installs it; the app reopens on the new version.
 */

import { Button } from '../components/ui/button'
import { Dialog } from '../components/ui/dialog'
import { type HexbotBridge, updateAction, type UpdateState } from '../lib/bridge'

/** The version an update would move to, if there is one to offer. */
export function updateTarget(state: null | UpdateState): null | string {
  if (!state) {
    return null
  }

  const action = updateAction(state)

  return action === 'install'
    ? state.downloadedVersion
    : action === 'download'
      ? state.availableVersion
      : null
}

/** Download if needed, then quit and install. Resolves only if something failed. */
export async function updateNow(bridge: HexbotBridge): Promise<void> {
  let state = await bridge.updater.state()

  if (updateAction(state) === 'download') {
    state = await bridge.updater.download()
  }

  if (updateAction(state) === 'install') {
    await bridge.updater.install()
  }
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
