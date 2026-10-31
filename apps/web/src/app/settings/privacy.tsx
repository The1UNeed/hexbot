import { USAGE_DOCS_URL } from '@hermes/shared'
import { useCallback, useEffect, useState } from 'react'

import { Switch } from '../../components/ui/switch'
import { getBridge, type PrivacyState } from '../../lib/bridge'
import { useSettings } from '../../stores/settings'
import { Group, Heading, Row } from '../bot-settings/shared'

/** Opens the page that lists every usage event, in the browser or the app. */
export function openUsageDocs(): void {
  const bridge = getBridge()

  if (bridge) {
    void bridge.openExternal(USAGE_DOCS_URL)
  } else {
    window.open(USAGE_DOCS_URL, '_blank', 'noopener,noreferrer')
  }
}

/** What usage data holds and what it never holds, in the words the privacy policy uses. */
export function UsageDataSummary() {
  return (
    <div className="space-y-2 text-[length:var(--text-secondary)] text-muted">
      <p>
        Shared: how many bots, rooms, and chats you have, that a message was sent, the Hexbot
        version, and your operating system. Tied to a random ID, not to you.
      </p>
      <p>Never shared: what you write, bot memory, files, names, keys, or your location.</p>
      <button className="text-accent underline" onClick={openUsageDocs} type="button">
        Every event we collect
      </button>
    </div>
  )
}

/** The desktop app's own switches; null in a browser or an app from before usage data. */
export function useAppPrivacy() {
  const bridge = getBridge()
  const [state, setState] = useState<null | PrivacyState>(null)

  const refresh = useCallback(() => {
    void bridge?.privacy?.().then(setState, () => setState(null))
  }, [bridge])

  useEffect(refresh, [refresh])

  const setUsageData = async (enabled: boolean) => {
    await bridge?.setUsageData?.(enabled)
    refresh()
  }

  const setCrashReports = async (enabled: boolean) => {
    await bridge?.setCrashReports(enabled)
    refresh()
  }

  return { setCrashReports, setUsageData, state }
}

export function PrivacySettings(): React.JSX.Element {
  const settings = useSettings(state => state.settings)
  const refresh = useSettings(state => state.refresh)
  const patch = useSettings(state => state.patch)
  const app = useAppPrivacy()
  useEffect(() => void refresh(), [refresh])

  // An older daemon has no usage data switch; there is nothing to send from it.
  const daemonSupported = settings ? settings.usage_data !== undefined : false

  return (
    <>
      <Heading description="What Hexbot shares with the Hexbot team. All of it is off until you turn it on.">
        Privacy
      </Heading>
      <div className="space-y-8">
        <Group footer={<UsageDataSummary />} title="Anonymous usage data">
          {app.state?.usageDataAvailable ? (
            <Row
              control={
                <Switch
                  aria-label="Share anonymous usage data from this app"
                  checked={app.state.usageData}
                  onCheckedChange={checked => void app.setUsageData(checked)}
                />
              }
              description="Once a day: that the app was opened, its version, and its edition."
              title="This app"
            />
          ) : null}
          {daemonSupported ? (
            <Row
              control={
                <Switch
                  aria-label="Share anonymous usage data from the daemon"
                  checked={settings?.usage_data === true}
                  onCheckedChange={checked => void patch({ usage_data: checked })}
                />
              }
              description="Counts of bots, rooms, chats, and messages, and error codes."
              title="Daemon"
            />
          ) : (
            <Row description="Update the daemon to choose what it shares." title="Daemon" />
          )}
        </Group>
        {app.state?.crashReportsAvailable ? (
          <Group
            footer="When the app crashes, Electron sends a crash report with the app's memory at that moment. Off unless you turn it on."
            title="Crash reports"
          >
            <Row
              control={
                <Switch
                  aria-label="Send crash reports"
                  checked={app.state.crashReports}
                  onCheckedChange={checked => void app.setCrashReports(checked)}
                />
              }
              title="Send crash reports"
            />
          </Group>
        ) : null}
      </div>
    </>
  )
}
