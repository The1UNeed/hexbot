import AsyncStorage from '@react-native-async-storage/async-storage'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'

import type { DaemonInfo } from '../../web/src/lib/types'
import {
  type AppsList,
  collectTargets,
  type DaemonCheck,
  type Plan,
  type PlanRow,
  type RunRow,
  type RunState,
  runUpdateEverything
} from '../../web/src/lib/update-everything'
import { daemonSteps, newId } from '../../web/src/lib/update-run-steps'
import type { Rpc } from './core/types'
import { ChoiceRow, confirm, Group, Row } from './ui'

/**
 * Settings, Updates on the phone: Update everything, the daemon and every
 * Hexbot app connected to it, with the same planner and steps as the web app
 * (apps/web/src/lib/update-everything.ts). The phone itself updates from
 * TestFlight or the App Store, so it is never a row.
 */

const SAVED = 'hexbot:update-run'

function detail(row: PlanRow | RunRow): string {
  if ('status' in row && row.status !== 'waiting' && row.message)
    return row.message
  if (row.skip) return row.from ? `${row.from} · ${row.skip}` : row.skip
  const to = row.to === 'newest' || !row.to ? 'the newest build' : row.to
  return `${row.from} → ${to}${row.track ? ` on ${row.track === 'nightly' ? 'Nightly' : 'Stable'}` : ''}`
}

export function UpdateEverything({
  connected,
  info,
  rpc
}: {
  connected: boolean
  info: DaemonInfo
  rpc: Rpc
}) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [run, setRun] = useState<RunState | null>(null)
  const [track, setTrack] = useState<'nightly' | 'stable' | null>(null)
  const running = useRef(false)

  const refresh = useCallback(async () => {
    const [apps, check] = await Promise.all([
      rpc<AppsList>('hexbot.apps.list').catch(() => null),
      rpc<DaemonCheck>('hexbot.update.check').catch(() => null)
    ])
    if (!apps) return
    setTrack(check?.track ?? null)
    setPlan(
      collectTargets({
        apps,
        check,
        daemon: { capability: info.update_capability ?? null, version: info.version },
        thisApp: null
      })
    )
  }, [info.update_capability, info.version, rpc])

  useEffect(() => {
    if (!connected) return
    void refresh()
    // Apps report as they change; the page asks again while it is open.
    const timer = setInterval(() => void refresh(), 5_000)
    return () => clearInterval(timer)
  }, [connected, refresh])

  // iOS stops the app in the background: a run left part way shows what it
  // reached when the app comes back. The claim and each prepared update
  // expire on their own, so nothing waits on the phone for long.
  useEffect(() => {
    void AsyncStorage.getItem(SAVED).then(raw => {
      if (raw && !running.current) setRun(JSON.parse(raw) as RunState)
    })
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active' && !running.current)
        void AsyncStorage.getItem(SAVED).then(raw => raw && setRun(JSON.parse(raw) as RunState))
    })
    return () => subscription.remove()
  }, [])

  const start = async () => {
    if (!plan?.actionable || running.current) return
    running.current = true
    const daemon = daemonSteps(rpc)
    try {
      await runUpdateEverything(
        plan,
        {
          ...daemon,
          prepareApp: (row, requestId) => daemon.prepareRemoteApp(row, requestId),
          // No app runs here: nothing counts down and nothing relaunches.
          countdown: async () => false,
          save: () => undefined,
          commitThisApp: async () => undefined,
          cancelThisApp: async () => undefined,
          id: newId
        },
        state => {
          setRun(state)
          void (state.result
            ? AsyncStorage.removeItem(SAVED)
            : AsyncStorage.setItem(SAVED, JSON.stringify(state)))
        }
      )
    } finally {
      running.current = false
      void refresh()
    }
  }

  const rows = run?.rows ?? plan?.rows ?? []
  const done = !!run?.result || (!!run && !running.current)
  return (
    <>
      <Group
        title="Everything"
        footer={
          run?.result?.message ??
          plan?.blocked ??
          'The daemon restarts first and goes back to its version if the new one cannot start. Every app shows Restart in 10s · Later.'
        }
      >
        {rows.map(row => (
          <Row
            key={row.key}
            title={row.label}
            subtitle={detail(row)}
            subtitleTone={'status' in row && row.status === 'failed' ? 'danger' : undefined}
            testID={`update-row-${row.key}`}
          />
        ))}
        {done ? (
          <Row
            title="Dismiss"
            testID="update-everything-dismiss"
            onPress={() => {
              setRun(null)
              void AsyncStorage.removeItem(SAVED)
            }}
          />
        ) : (
          <Row
            title={run ? 'Updating…' : (plan?.summary ?? 'Checking for updates…')}
            testID="update-everything"
            disabled={!connected || !!run || !plan?.actionable}
            onPress={() =>
              confirm(
                'Update everything?',
                `${plan?.summary ?? ''}. Bots stop while the daemon restarts.`,
                () => void start()
              )
            }
          />
        )}
      </Group>
      <Group
        title="Track"
        footer="The daemon and every app switch together, and each moves once the new track has a newer build than it runs. Nightly is built from main every day and may break."
      >
        {(['stable', 'nightly'] as const).map(choice => (
          <ChoiceRow
            key={choice}
            title={choice === 'stable' ? 'Stable' : 'Nightly'}
            selected={track === choice}
            disabled={!connected || !track || !!run}
            testID={`update-track-${choice}`}
            onPress={() => {
              if (choice === track) return
              setTrack(choice)
              void rpc('hexbot.update.set_track', { track: choice }).then(() => refresh())
            }}
          />
        ))}
      </Group>
      <Group title="This phone" footer="Update the app from TestFlight or the App Store.">
        <Row
          title="Hexbot on this phone"
          testID="update-this-phone"
          subtitle="Updates through the App Store"
        />
      </Group>
    </>
  )
}
