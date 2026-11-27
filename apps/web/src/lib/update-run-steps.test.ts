import { describe, expect, it } from 'vitest'

import type { ReportedApp, RunRow } from './update-everything'
import { daemonSteps, newId } from './update-run-steps'

const row: RunRow = {
  appId: 'app.hexbot.client',
  device: 'laptop',
  from: '0.1.6',
  key: 'laptop/app.hexbot.client',
  kind: 'app',
  label: 'Laptop',
  message: null,
  requestId: 'r1',
  skip: null,
  status: 'ready',
  to: '0.1.7',
  track: 'stable'
}

/** A daemon whose apps list answers with what the test says the app reports. */
function daemon(report: () => null | Partial<ReportedApp>) {
  const calls: [string, Record<string, unknown> | undefined][] = []

  const rpc = async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
    calls.push([method, params])

    if (method === 'hexbot.apps.list') {
      const app = report()

      return {
        apps: app ? [{ app_id: 'app.hexbot.client', device: 'laptop', ...app }] : [],
        older: [],
        run: null
      } as T
    }

    return {} as T
  }

  return { calls, steps: daemonSteps(rpc) }
}

describe('daemonSteps', () => {
  it('asks the app through the daemon and reads what it reports', async () => {
    const { calls, steps } = daemon(() => ({
      request: { downloaded_version: '0.1.7', error: null, id: 'r1', state: 'ready' }
    }))

    expect(await steps.prepareRemoteApp(row, 'r1')).toEqual({ ok: true, version: '0.1.7' })
    expect(calls[0]).toEqual([
      'hexbot.apps.update',
      {
        action: 'prepare',
        app_id: 'app.hexbot.client',
        device: 'laptop',
        request_id: 'r1',
        track: 'stable',
        version: '0.1.7'
      }
    ])
    expect(await steps.waitReady(row, 'r1')).toBe(true)
  })

  it('reports Later and a restart from what the app does after a commit', async () => {
    let state: 'installing' | 'postponed' = 'postponed'

    const { steps } = daemon(() => ({
      request: { downloaded_version: '0.1.7', error: null, id: 'r1', state }
    }))

    expect(await steps.commitApp(row, 'r1')).toBe('postponed')
    state = 'installing'
    expect(await steps.commitApp(row, 'r1')).toBe('installing')
    // An app that left once its countdown began is restarting.
    let seen = false
    const leaving = daemon(() => {
      if (seen) {
        return null
      }

      seen = true

      return { request: { downloaded_version: '0.1.7', error: null, id: 'r1', state: 'countdown' } }
    })

    expect(await leaving.steps.commitApp(row, 'r1')).toBe('installing')
  })

  it('makes ids the daemon takes as names', () => {
    expect(newId()).toMatch(/^[A-Za-z0-9]{1,32}$/)
  })
})
