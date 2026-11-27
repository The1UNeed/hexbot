import { describe, expect, it } from 'vitest'

import {
  type AppsList,
  collectTargets,
  describeCapsule,
  type Fleet,
  type ReportedApp,
  type RunState,
  type RunSteps,
  runUpdateEverything
} from './update-everything'

const app = (overrides: Partial<ReportedApp>): ReportedApp => ({
  app_id: 'app.hexbot.client',
  current: false,
  device: 'laptop',
  edition: 'client',
  hosts_daemon: false,
  label: 'Laptop',
  platform: 'linux',
  request: null,
  track: 'stable',
  updater: {
    available: null,
    downloaded: null,
    message: null,
    percent: null,
    status: 'up-to-date'
  },
  version: '0.1.6',
  ...overrides
})

const list = (apps: ReportedApp[], extra: Partial<AppsList> = {}): AppsList => ({
  apps,
  older: [],
  run: null,
  ...extra
})

const fleet = (overrides: Partial<Fleet> = {}): Fleet => ({
  apps: list([]),
  check: { current: '0.1.6', latest: '0.1.7', newer: true, track: 'stable' },
  daemon: { capability: 'service', version: '0.1.6' },
  thisApp: {
    appId: 'app.hexbot.desktop',
    hostsDaemon: false,
    platform: 'darwin',
    track: 'stable',
    updater: { availableVersion: '0.1.7', downloadedVersion: null, status: 'available' },
    version: '0.1.6'
  },
  ...overrides
})

const row = (plan: ReturnType<typeof collectTargets>, key: string) =>
  plan.rows.find(r => r.key === key)!

describe('collectTargets', () => {
  it('plans the daemon, this app and each other app behind it', () => {
    const plan = collectTargets(
      fleet({ apps: list([app({}), app({ device: 'mini', label: 'Mini', version: '0.1.7' })]) })
    )

    expect(plan.daemon).toBe('service')
    expect(row(plan, 'daemon')).toMatchObject({ from: '0.1.6', skip: null, to: '0.1.7' })
    expect(row(plan, 'this-app')).toMatchObject({ skip: null, to: '0.1.7' })
    expect(row(plan, 'laptop/app.hexbot.client')).toMatchObject({ skip: null, to: '0.1.7' })
    expect(row(plan, 'mini/app.hexbot.client')).toMatchObject({ skip: 'Up to date', to: null })
    expect(plan.summary).toBe('Update the daemon, this app and Laptop')
    expect(plan.actionable).toBe(true)
  })

  it('moves an app on the other track only when the daemon moves', () => {
    const nightly = app({ track: 'nightly', version: '0.1.7-nightly.20261120.1' })
    const moving = collectTargets(fleet({ apps: list([nightly]) }))
    expect(row(moving, 'laptop/app.hexbot.client')).toMatchObject({ skip: null, track: 'stable' })

    const still = collectTargets(
      fleet({
        apps: list([nightly]),
        check: { current: '0.1.6', latest: '0.1.6', newer: false, track: 'stable' }
      })
    )

    expect(row(still, 'laptop/app.hexbot.client').skip).toBe('Moves with the daemon')
    // A remote Mac can't relaunch a bundle the switch renamed.
    const mac = collectTargets(fleet({ apps: list([{ ...nightly, platform: 'darwin' }]) }))
    expect(row(mac, 'laptop/app.hexbot.client').skip).toBe('Switch tracks on that Mac')
  })

  it('says when a daemon moves to the new track only with its next release', () => {
    const plan = collectTargets(
      fleet({
        check: {
          current: '0.1.7-nightly.20261120.1',
          latest: '0.1.6',
          newer: false,
          track: 'stable'
        },
        daemon: { capability: 'service', version: '0.1.7-nightly.20261120.1' }
      }),
      'stable'
    )

    expect(row(plan, 'daemon').skip).toBe('Moves to Stable with the next Stable release')
  })

  it('updates a daemon an app runs with that app, or asks it last', () => {
    const host = app({ hosts_daemon: true, label: 'Studio', device: 'studio' })

    const hosted = collectTargets(
      fleet({ apps: list([host]), daemon: { capability: 'desktop', version: '0.1.6' } })
    )

    expect(hosted.daemon).toBe('host-app')
    expect(row(hosted, 'daemon').label).toBe('Daemon, with Studio')
    expect(row(hosted, 'studio/app.hexbot.client')).toMatchObject({
      hostsDaemon: true,
      to: '0.1.7'
    })
    const alone = collectTargets(fleet({ daemon: { capability: 'desktop', version: '0.1.6' } }))
    expect(alone.daemon).toBe('request-last')

    const own = collectTargets(
      fleet({
        daemon: { capability: 'desktop', version: '0.1.6' },
        thisApp: { ...fleet().thisApp!, hostsDaemon: true }
      })
    )

    expect(own.daemon).toBe('this-app')
    expect(row(own, 'this-app')).toMatchObject({ hostsDaemon: true, to: '0.1.7' })
  })

  it('lists apps it cannot update and waits for another run', () => {
    const plan = collectTargets(
      fleet({
        apps: list([], {
          older: [{ device: 'old', label: 'Old laptop' }],
          run: { device: 'x', expires_at: 1, run_id: 'other' }
        }),
        daemon: { capability: null, version: '0.1.6' }
      })
    )

    expect(row(plan, 'daemon').skip).toBe('Update on that computer')
    expect(row(plan, 'older/old').skip).toBe('Update on that computer')
    expect(plan.blocked).toBe('Another update is running on this daemon.')
    expect(plan.actionable).toBe(false)
    expect(
      collectTargets(
        fleet({
          apps: list([], { run: { device: 'x', expires_at: 1, run_id: 'mine' } }),
          runId: 'mine'
        })
      ).blocked
    ).toBeNull()
  })
})

function steps(overrides: Partial<RunSteps> = {}): { calls: string[]; steps: RunSteps } {
  const calls: string[] = []
  let next = 0

  const record =
    <T>(name: string, value: T) =>
    async (...args: unknown[]) => {
      calls.push(
        [
          name,
          ...args.map(a => (typeof a === 'object' && a ? (a as { key: string }).key : String(a)))
        ].join(' ')
      )

      return value
    }

  return {
    calls,
    steps: {
      cancelApp: record('cancel', undefined),
      cancelThisApp: record('cancel-this', undefined),
      claim: record('claim', undefined),
      commitApp: record('commit', 'installing' as const),
      commitThisApp: record('commit-this', undefined),
      countdown: record('countdown', true),
      id: () => `id${next++}`,
      prepareApp: record('prepare', { ok: true }),
      release: record('release', undefined),
      requestDaemon: record('request-daemon', undefined),
      restartDaemon: record('restart-daemon', {
        at: '',
        from: '0.1.6',
        id: 'id1',
        reason: null,
        status: 'committed' as const,
        to: '0.1.7'
      }),
      save: (state: RunState) => void calls.push(`save ${state.phase}`),
      stageDaemon: record('stage', { ok: true }),
      waitReady: record('wait', true),
      ...overrides
    }
  }
}

describe('runUpdateEverything', () => {
  it('prepares everything, restarts the daemon, then the apps, the daemon host last, this app last of all', async () => {
    const plan = collectTargets(
      fleet({
        apps: list([app({ device: 'studio', hosts_daemon: true, label: 'Studio' }), app({})])
      })
    )

    const { calls, steps: run } = steps()
    const end = await runUpdateEverything(plan, run, () => undefined)
    expect(calls).toEqual([
      'claim id0',
      'stage id1 0.1.7',
      'prepare studio/app.hexbot.client id2',
      'prepare laptop/app.hexbot.client id3',
      'prepare this-app id4',
      // The claim is renewed at each phase.
      'claim id0',
      'restart-daemon id1 0.1.7',
      'wait studio/app.hexbot.client id2',
      'wait laptop/app.hexbot.client id3',
      'claim id0',
      'commit laptop/app.hexbot.client id3',
      'commit studio/app.hexbot.client id2',
      'countdown',
      'save restarting-this-app',
      'commit-this id4',
      // Reached only because this fake install returns; a real one relaunches.
      'release id0'
    ])
    expect(end.rows.find(r => r.kind === 'daemon')?.status).toBe('done')
  })

  it('cancels every prepared app when the daemon rolls back', async () => {
    const plan = collectTargets(fleet({ apps: list([app({})]) }))

    const { calls, steps: run } = steps({
      restartDaemon: async () => ({
        at: '',
        from: '0.1.6',
        id: 'id1',
        reason: 'crashed while starting',
        status: 'rolled-back',
        to: '0.1.7'
      })
    })

    const end = await runUpdateEverything(plan, run, () => undefined)
    expect(calls).toContain('cancel laptop/app.hexbot.client id2')
    expect(calls).toContain('cancel-this id3')
    expect(calls.some(c => c.startsWith('commit'))).toBe(false)
    expect(end.result).toEqual({
      message: 'Daemon: Rolled back to 0.1.6: it crashed while starting',
      ok: false
    })
    expect(calls.at(-1)).toBe('release id0')
  })

  it('settles Later on another app without calling it a failure', async () => {
    const plan = collectTargets(fleet({ apps: list([app({})]), thisApp: null }))
    const { steps: run } = steps({ commitApp: async () => 'postponed' })
    const end = await runUpdateEverything(plan, run, () => undefined)
    expect(end.rows.find(r => r.kind === 'app')).toMatchObject({
      message: 'Later on Laptop',
      status: 'later'
    })
    expect(end.result).toEqual({ message: 'Updated, except Laptop (Later)', ok: true })
  })

  it('skips only the row whose prepare failed', async () => {
    const plan = collectTargets(fleet({ apps: list([app({})]), thisApp: null }))

    const { calls, steps: run } = steps({
      prepareApp: async () => ({ error: 'No space left', ok: false })
    })

    const end = await runUpdateEverything(plan, run, () => undefined)
    expect(calls).toContain('restart-daemon id1 0.1.7')
    expect(end.rows.find(r => r.kind === 'app')).toMatchObject({
      message: 'No space left',
      status: 'failed'
    })
    expect(end.result?.ok).toBe(false)
  })

  it('stops before touching anything when another run holds the daemon', async () => {
    const { calls, steps: run } = steps({
      claim: async () => {
        throw new Error('Another update is running')
      }
    })

    const end = await runUpdateEverything(collectTargets(fleet()), run, () => undefined)
    expect(end.result).toEqual({ message: 'Another update is running', ok: false })
    expect(calls).toEqual(['release id0'])
  })
})

describe('describeCapsule', () => {
  it('counts what is done and shows the countdown', () => {
    const state: RunState = {
      phase: 'committing',
      result: null,
      rows: [
        {
          from: '',
          key: 'a',
          kind: 'daemon',
          label: 'Daemon',
          message: null,
          requestId: null,
          skip: null,
          status: 'done',
          to: null,
          track: null
        },
        {
          from: '',
          key: 'b',
          kind: 'app',
          label: 'Laptop',
          message: null,
          requestId: null,
          skip: null,
          status: 'updating',
          to: null,
          track: null
        },
        {
          from: '',
          key: 'c',
          kind: 'app',
          label: 'Mini',
          message: null,
          requestId: null,
          skip: 'Up to date',
          status: 'skipped',
          to: null,
          track: null
        }
      ],
      runId: 'r'
    }

    expect(describeCapsule(state, null)).toBe('1 of 2 updated')
    expect(describeCapsule({ ...state, phase: 'counting-down' }, 4)).toBe('Restart in 4s · Later')
    expect(describeCapsule({ ...state, phase: 'done' }, null)).toBeNull()
  })
})
