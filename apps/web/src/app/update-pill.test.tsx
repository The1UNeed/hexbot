import type { UpdateState } from '../lib/bridge'

import { describePill } from './update-pill'

const idle: UpdateState = {
  availableVersion: null,
  channel: 'nightly',
  checkedAt: null,
  currentVersion: '0.1.5-nightly.20260914.6',
  downloadedVersion: null,
  errorContext: null,
  message: null,
  percent: null,
  status: 'idle'
}

describe('describePill', () => {
  it('stays hidden while everything is current', () => {
    expect(describePill(null, null, null, null)).toBeNull()
    expect(describePill(idle, null, idle.currentVersion, idle.currentVersion)).toBeNull()
    expect(describePill({ ...idle, status: 'up-to-date' }, null, '1.0.0', '1.0.0')).toBeNull()
    expect(describePill({ ...idle, status: 'checking' }, null, '1.0.0', '1.0.0')).toBeNull()
  })

  it('walks an app update', () => {
    const available = {
      ...idle,
      availableVersion: '0.1.5-nightly.20260916.9',
      status: 'available' as const
    }
    expect(describePill(available, null, null, null)).toMatchObject({
      action: 'download',
      label: 'Download update'
    })
    expect(
      describePill({ ...available, percent: 42, status: 'downloading' }, null, null, null)
    ).toMatchObject({
      action: null,
      busy: true,
      label: 'Downloading 42%'
    })
    expect(
      describePill(
        { ...available, downloadedVersion: available.availableVersion, status: 'downloaded' },
        null,
        null,
        null
      )
    ).toMatchObject({ action: 'install', label: 'Restart to update' })
    expect(
      describePill(
        { ...available, errorContext: 'download', message: 'disk full', status: 'error' },
        null,
        null,
        null
      )
    ).toMatchObject({
      action: 'download',
      label: 'Retry download',
      title: 'Download failed: disk full'
    })
  })

  it('points at a daemon that is behind, and follows its update', () => {
    expect(
      describePill(idle, null, '0.1.5-nightly.20260916.9', '0.1.5-nightly.20260914.6')
    ).toMatchObject({
      action: 'settings',
      label: 'Update daemon'
    })
    const update = { message: null, percent: 30, status: 'downloading' as const, target: '2.0.0' }
    expect(describePill(idle, update, '2.0.0', '1.0.0')).toMatchObject({
      action: 'settings',
      busy: true,
      label: 'Updating daemon'
    })
    expect(
      describePill(
        idle,
        { ...update, message: 'uv sync failed', status: 'failed' },
        '2.0.0',
        '1.0.0'
      )
    ).toMatchObject({ action: 'settings', label: 'Daemon update failed', title: 'uv sync failed' })
  })

  it('shows the app update before the daemon one', () => {
    const available = { ...idle, availableVersion: '3.0.0', status: 'available' as const }
    expect(describePill(available, null, '2.0.0', '1.0.0')?.label).toBe('Download update')
  })
})
