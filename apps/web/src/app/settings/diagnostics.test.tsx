import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, vi } from 'vitest'

import { diagnosticsGet, diagnosticsTrace } from '../../lib/api'
import type { DiagnosticsSnapshot } from '../../lib/types'

import {
  DiagnosticsSettings,
  formatBytes,
  formatMs,
  formatPercent,
  formatUptime
} from './diagnostics'

vi.mock('../../lib/api', async importOriginal => ({
  ...(await importOriginal()),
  diagnosticsGet: vi.fn(),
  diagnosticsTrace: vi.fn(),
  gatewayPing: vi.fn().mockResolvedValue({ pong: true })
}))

const NOW = 1_800_000_000_000

function snapshot(): DiagnosticsSnapshot {
  return {
    caches: {
      prompt: {
        by_bot: [
          {
            cache_read: 900,
            cache_write: 0,
            calls: 4,
            cost: 0.2,
            hit_rate: 0.9,
            input: 100,
            name: 'owl',
            output: 50
          }
        ],
        by_model: [],
        cache_read: 900,
        cache_write: 0,
        calls: 4,
        hit_rate: 0.9,
        input: 100,
        output: 50,
        window_h: 24
      },
      sqlite: {
        busiest: [],
        cache_hit_rate: 0.75,
        cache_hits: 30,
        cache_misses: 10,
        db_bytes: 2048,
        runtime_db_bytes: 4096,
        open_avg_ms: 0.4,
        open_max_ms: 2,
        opens: 6,
        slowest: [{ avg_ms: 3, count: 2, max_ms: 5, sql: 'SELECT * FROM bots', total_ms: 6 }],
        statement_avg_ms: 0.2,
        statement_total_ms: 8,
        statements: 40,
        wal_bytes: 0
      }
    },
    daemon: {
      home: '/tmp/hexbot',
      pi_version: '1.2.3',
      pid: 42,
      started_at: NOW - 3_600_000,
      supervisor: 'desktop',
      uptime_s: 3600,
      version: '0.9.0'
    },
    failures: {
      common: [
        {
          count: 3,
          example: 'Rate limited',
          first: NOW - 60_000,
          kind: 'run',
          last: NOW - 1000,
          pattern: 'Rate limited',
          source: 'owl'
        }
      ],
      recent: [{ at: NOW - 1000, kind: 'run', message: 'Rate limited', source: 'owl', trace: 7 }],
      total: 3
    },
    generated_at: NOW,
    host: {
      arch: 'arm64',
      cpu_cores: 10,
      cpu_model: 'Apple M2',
      hostname: 'studio',
      kernel: 'Darwin 25.5.0',
      load: [1.5, 1.2, 1],
      memory_available: 8 * 1024 ** 3,
      memory_total: 16 * 1024 ** 3,
      os: 'macos',
      os_version: 'macOS 26.1'
    },
    launch: {
      phases: [
        { duration_ms: 40, name: 'Upgrade the database', start_ms: 5 },
        { duration_ms: 120, name: 'Start bots, rooms and memory', start_ms: 50 }
      ],
      total_ms: 180
    },
    load: {
      capacity: 16,
      capacity_free: 15,
      open_runs: 1,
      rpc_per_minute: 12,
      running: 1,
      runs_last_hour: 4,
      sessions: 1,
      sockets: 2
    },
    resources: {
      error: null,
      interval_s: 5,
      processes: [
        {
          cpu: 3.2,
          depth: 0,
          history: [[NOW, 3.2, 50_000_000]],
          label: 'Hexbot daemon',
          name: 'hexbot',
          pid: 42,
          ppid: 1,
          rss: 50_000_000
        },
        {
          cpu: 12,
          depth: 1,
          history: null,
          label: 'Pi · owl',
          name: 'node',
          pid: 43,
          ppid: 42,
          rss: 120_000_000
        }
      ],
      samples: [
        {
          cpu: 10,
          daemon_cpu: 3,
          daemon_rss: 50_000_000,
          processes: 2,
          rss: 170_000_000,
          t: NOW - 5000
        },
        {
          cpu: 15.2,
          daemon_cpu: 3.2,
          daemon_rss: 50_000_000,
          processes: 2,
          rss: 170_000_000,
          t: NOW
        }
      ]
    },
    spans: {
      capacity: 4000,
      kept: 3,
      names: [
        {
          avg_ms: 2400,
          count: 1,
          errors: 1,
          kind: 'run',
          last_at: NOW - 1000,
          max_ms: 2400,
          name: 'run owl',
          p95_ms: 2400,
          total_ms: 2400
        }
      ],
      recent: [
        {
          attrs: {},
          duration_ms: 2400,
          error: 'Rate limited',
          id: 7,
          kind: 'run',
          name: 'run owl',
          parent: null,
          start: NOW - 3400,
          trace: 7
        }
      ],
      traces: [
        {
          attrs: { bot: 'owl', cache_hit_rate: 0.9, model_calls: 2, tool_calls: 1 },
          duration_ms: 2400,
          error: 'Rate limited',
          errors: 1,
          id: 7,
          kind: 'run',
          name: 'run owl',
          parent: null,
          spans: 3,
          start: NOW - 3400,
          trace: 7
        }
      ]
    }
  }
}

describe('diagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(diagnosticsGet).mockResolvedValue(snapshot())
  })

  it('formats durations, sizes and rates for people', () => {
    expect(formatMs(0.25)).toBe('0.25 ms')
    expect(formatMs(812.4)).toBe('812 ms')
    expect(formatMs(1234)).toBe('1.23 s')
    expect(formatMs(125_000)).toBe('2 min 5 s')
    expect(formatMs(null)).toBe('—')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(170_000_000)).toBe('162 MB')
    expect(formatPercent(0.756)).toBe('75.6%')
    expect(formatPercent(null)).toBe('—')
    expect(formatUptime(90_061)).toBe('1 d 1 h')
  })

  it('leads with the launch, resources and cache figures', async () => {
    render(<DiagnosticsSettings />)

    expect(await screen.findByText('180 ms')).toBeInTheDocument()
    expect(screen.getByText('Launch time')).toBeInTheDocument()
    expect(screen.getByText('15%')).toBeInTheDocument()
    expect(screen.getByText('90%')).toBeInTheDocument()
    expect(screen.getByText('75%')).toBeInTheDocument()
    expect(screen.getByText('Start bots, rooms and memory')).toBeInTheDocument()
    expect(screen.getByText('The Hexbot app')).toBeInTheDocument()
    expect(screen.getByText('studio')).toBeInTheDocument()
  })

  it('shows the live process tree with its bot labels', async () => {
    render(<DiagnosticsSettings />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Resources' }))

    expect(screen.getByText('Pi · owl')).toBeInTheDocument()
    expect(screen.getByText('node · PID 43')).toBeInTheDocument()
    expect(screen.getByText('Hexbot daemon')).toBeInTheDocument()
  })

  it('opens a run from its failure and draws its steps', async () => {
    vi.mocked(diagnosticsTrace).mockResolvedValue({
      spans: [
        {
          attrs: { bot: 'owl' },
          duration_ms: 2400,
          error: 'Rate limited',
          id: 7,
          kind: 'run',
          name: 'run owl',
          parent: null,
          start: NOW - 3400,
          trace: 7
        },
        {
          attrs: { cache_hit_rate: 0.9, input: 100, model: 'm1' },
          duration_ms: 900,
          error: null,
          id: 8,
          kind: 'model',
          name: 'model m1',
          parent: 7,
          start: NOW - 3400,
          trace: 7
        }
      ],
      trace: 7
    })
    render(<DiagnosticsSettings />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Failures' }))

    expect(screen.getByText('3×')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show run' }))

    expect(diagnosticsTrace).toHaveBeenCalledWith(7)
    fireEvent.click(await screen.findByRole('button', { name: /model m1/ }))
    expect(screen.getByText('Cache hits')).toBeInTheDocument()
    expect(screen.getByText('m1')).toBeInTheDocument()
  })

  it('opens a failed run that is older than the recent runs', async () => {
    const old = snapshot()

    old.spans.traces = []
    vi.mocked(diagnosticsGet).mockResolvedValue(old)
    vi.mocked(diagnosticsTrace).mockResolvedValue({ spans: [], trace: 7 })
    render(<DiagnosticsSettings />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Failures' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show run' }))

    expect(
      await screen.findByText('This run is older than the spans the daemon keeps.')
    ).toBeInTheDocument()
  })

  it('saves the report as a file when the clipboard is not allowed', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('not allowed'))
    const createObjectURL = vi.fn().mockReturnValue('blob:report')
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() })
    render(<DiagnosticsSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Copy report' }))

    expect(await screen.findByRole('button', { name: 'Saved' })).toBeInTheDocument()
    expect(click).toHaveBeenCalled()
    expect(createObjectURL).toHaveBeenCalled()
    click.mockRestore()
    vi.unstubAllGlobals()
  })

  it('filters the span log by name', async () => {
    render(<DiagnosticsSettings />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Traces' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'run owl' })[0]!)

    await waitFor(() => expect(diagnosticsGet).toHaveBeenLastCalledWith('run owl'))
  })

  it('says when the daemon is too old to report diagnostics', async () => {
    vi.mocked(diagnosticsGet).mockRejectedValue(
      Object.assign(new Error('unknown method'), { code: -32601 })
    )
    render(<DiagnosticsSettings />)

    expect(
      await screen.findByText(
        'This daemon does not report diagnostics. Update it to see them here.'
      )
    ).toBeInTheDocument()
  })
})
