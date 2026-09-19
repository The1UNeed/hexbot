/**
 * Full-window notice shown once the user asks the app to install a downloaded
 * update. It has no buttons on purpose: the install is already under way, and
 * the app closes and reopens on the new version by itself. If the install
 * fails the updater leaves the `installing` state and the notice goes away.
 */

import { Spinner } from '../components/ui/spinner'
import { HexbotMark } from '../components/ui/wordmark'
import { useUpdates } from '../stores/updates'

/** True while the desktop app is installing an update. */
export function useUpdateInstalling(): boolean {
  return useUpdates(state => state.app?.status === 'installing')
}

export function UpdateInstalling() {
  const version = useUpdates(state => state.app?.downloadedVersion)

  return (
    <div
      aria-labelledby="update-installing-title"
      aria-modal
      className="hex-fade fixed inset-0 z-[110] grid place-items-center bg-background/80 p-6 text-foreground backdrop-blur-sm"
      data-testid="update-installing"
      role="alertdialog"
    >
      <div aria-hidden className="hex-drag absolute inset-x-0 top-0 h-11" />
      <div className="hex-rise w-full max-w-[420px] space-y-5 rounded-window border border-border bg-surface p-6 text-center shadow-popup">
        <HexbotMark className="mx-auto" mood="working" size={56} />
        <div>
          <h1
            className="text-[length:var(--text-title)] font-semibold"
            id="update-installing-title"
          >
            Installing update
          </h1>
          <p className="mt-1 text-secondary text-muted">
            Hexbot is installing version {version} and will restart when it is done. Bots stop
            until it is back.
          </p>
        </div>
        <p className="flex items-center justify-center gap-2 text-secondary text-muted" role="status">
          <Spinner size="sm" />
          Restarting Hexbot…
        </p>
      </div>
    </div>
  )
}
