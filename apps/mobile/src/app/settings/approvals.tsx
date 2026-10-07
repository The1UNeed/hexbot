import { Stack } from 'expo-router'
import { useEffect, useState } from 'react'

import { Group, ListScroll } from '../../components/list'
import { ChoiceRow, errorText, Lead, Notice, PageState, useOnReconnect } from '../../components/settings/kit'
import { daemonInfo } from '../../lib/api'
import { useApprovalModes } from '../../lib/approval-modes'
import type { ApprovalMode, DaemonInfo } from '../../lib/types'
import { useConnection } from '../../stores/connection'
import { useSettings } from '../../stores/settings'

/** The deployment's approval mode. Bots and rooms can override it in their own settings. */
export default function Approvals() {
  const settings = useSettings(state => state.settings)
  const loadError = useSettings(state => state.error)
  const refresh = useSettings(state => state.refresh)
  const patch = useSettings(state => state.patch)
  const cached = useConnection(state => state.daemon)
  const [info, setInfo] = useState<DaemonInfo | null>(cached)
  const [pending, setPending] = useState<ApprovalMode | null>(null)
  const [error, setError] = useState<null | string>(null)
  const modes = useApprovalModes(settings?.approval_mode)

  useEffect(() => {
    void refresh()
    // Without daemon info, as from an older daemon, there is nothing to warn about.
    void daemonInfo()
      .then(setInfo)
      .catch(() => undefined)
  }, [refresh])
  useOnReconnect(refresh)

  const choose = async (mode: ApprovalMode) => {
    if (mode === settings?.approval_mode) {
      return
    }

    setPending(mode)
    setError(null)

    try {
      await patch({ approval_mode: mode })
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setPending(null)
    }
  }

  const current = pending ?? settings?.approval_mode

  return (
    <>
      <Stack.Screen options={{ title: 'Approvals' }} />
      <ListScroll testID="approvals">
        <Lead>Choose when Hexbot asks before a bot acts. Bots and rooms can override it.</Lead>
        {info && info.approvals !== 'sandbox' ? (
          <Notice>This daemon is older than the app and still uses its previous approval rules. Update the daemon to get the sandbox these modes describe.</Notice>
        ) : null}
        {info?.approvals === 'sandbox' && info.sandbox === null ? (
          <Notice testID="approvals-no-sandbox">
            No OS sandbox is available, so Manual and Auto ask before every shell command and code run. Install bubblewrap on the computer running
            the daemon, then restart it.
          </Notice>
        ) : null}
        {settings ? (
          <Group error={error} label="Mode">
            {modes.map(mode => (
              <ChoiceRow
                checked={current === mode.value}
                description={mode.description}
                key={mode.value}
                onPress={() => void choose(mode.value)}
                testID={`approvals-${mode.label.toLowerCase()}`}
                title={mode.label}
              />
            ))}
          </Group>
        ) : (
          <PageState error={loadError} onRetry={() => void refresh()} />
        )}
      </ListScroll>
    </>
  )
}
