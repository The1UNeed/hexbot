import { describe, expect, it } from 'vitest'
import {
  disabledReason,
  initialUpdateState,
  nextAction,
  onAvailable,
  onCheckError,
  onCheckStart,
  onDownloadError,
  onDownloadStart,
  onDownloaded,
  onInstallError,
  onInstallStart,
  onProgress,
  onUpToDate,
  afterRelaunch,
  remoteReady,
  versionChannel
} from './update-state'

const idle = initialUpdateState('0.1.5-nightly.20260914.6', 'nightly', null)
const at = '2026-09-17T09:00:00.000Z'

describe('disabledReason', () => {
  it('turns the updater off for dev, unpackaged, and non-AppImage Linux builds', () => {
    expect(disabledReason({ packaged: true, channel: 'dev', platform: 'darwin' })).toMatch(/Dev/)
    expect(disabledReason({ packaged: false, channel: 'nightly', platform: 'darwin' })).toMatch(
      /packaged/
    )
    expect(disabledReason({ packaged: true, channel: 'nightly', platform: 'linux' })).toMatch(
      /AppImage/
    )
    expect(
      disabledReason({
        packaged: true,
        channel: 'nightly',
        platform: 'linux',
        appImage: '/a.AppImage'
      })
    ).toBeNull()
    expect(disabledReason({ packaged: true, channel: 'stable', platform: 'darwin' })).toBeNull()
    expect(initialUpdateState('1.0.0', 'stable', 'off').status).toBe('disabled')
  })
})

describe('update transitions', () => {
  it('walks check, download, and install', () => {
    const checking = onCheckStart(idle)
    expect(checking.status).toBe('checking')
    const available = onAvailable(checking, '0.1.5-nightly.20260916.9', at)
    expect(available).toMatchObject({
      status: 'available',
      availableVersion: '0.1.5-nightly.20260916.9',
      checkedAt: at
    })
    expect(nextAction(available)).toBe('download')
    const downloading = onDownloadStart(available)
    expect(nextAction(downloading)).toBeNull()
    expect(onProgress(downloading, 42.7).percent).toBe(42)
    expect(onProgress(available, 42.7)).toBe(available)
    const downloaded = onDownloaded(downloading, '0.1.5-nightly.20260916.9')
    expect(downloaded).toMatchObject({ status: 'downloaded', percent: 100 })
    expect(nextAction(downloaded)).toBe('install')
    // Installing offers nothing: the app is about to close and reopen.
    const installing = onInstallStart(downloaded)
    expect(installing).toMatchObject({
      status: 'installing',
      downloadedVersion: downloaded.downloadedVersion
    })
    expect(nextAction(installing)).toBeNull()
    // A later poll finds the same version again: still ready to install.
    expect(onAvailable(onCheckStart(downloaded), '0.1.5-nightly.20260916.9', at).status).toBe(
      'downloaded'
    )
  })

  it('keeps the retry that fits the failure', () => {
    const checkFailed = onCheckError(onCheckStart(idle), 'offline', at)
    expect(checkFailed).toMatchObject({
      status: 'error',
      errorContext: 'check',
      message: 'offline'
    })
    expect(nextAction(checkFailed)).toBe('check')
    const available = onAvailable(idle, '2.0.0', at)
    const downloadFailed = onDownloadError(onDownloadStart(available), 'disk full')
    expect(nextAction(downloadFailed)).toBe('download')
    const installFailed = onInstallError(onDownloaded(available, '2.0.0'), 'signature')
    expect(nextAction(installFailed)).toBe('install')
    expect(nextAction(onUpToDate(available, at))).toBe('check')
    expect(onUpToDate(onDownloaded(available, '2.0.0'), at).downloadedVersion).toBeNull()
  })
})

describe('versionChannel', () => {
  it('puts nightly versions on the nightly track and everything else on stable', () => {
    expect(versionChannel('0.1.5-nightly.20260916.9')).toBe('nightly')
    expect(versionChannel('0.1.5-alpha.1')).toBe('stable')
    expect(versionChannel('1.0.0')).toBe('stable')
  })
})

describe('Update everything on this app', () => {
  it('is ready only with the download on disk, and says why not otherwise', () => {
    const downloaded = onDownloaded(
      onDownloadStart(onAvailable(idle, '0.1.6-nightly.20260915.1', at)),
      '0.1.6-nightly.20260915.1'
    )
    expect(remoteReady(downloaded)).toEqual({ ready: true, version: '0.1.6-nightly.20260915.1' })
    expect(remoteReady(onUpToDate(idle, at))).toEqual({
      ready: false,
      error: 'Nothing newer on the Nightly track.'
    })
    expect(remoteReady(onDownloadError(downloaded, 'disk full'))).toEqual({
      ready: false,
      error: 'disk full'
    })
  })

  it('finds an update that did not apply and forgets what the running version settles', () => {
    const now = 1_000
    const entry = (version: string, edition: 'full' | 'client', expiresAt = 2_000) => ({
      version,
      requestId: 'r1',
      daemon: 'd1',
      edition,
      expiresAt
    })
    const pending = {
      'app.hexbot.desktop': entry('0.1.7', 'full'),
      // The same app before a track switch changed its id: settled.
      'app.hexbot.desktop.nightly': entry('0.1.6', 'full'),
      // Another app on this computer keeps its entry.
      'app.hexbot.client': entry('0.1.7', 'client'),
      'app.hexbot.old': entry('0.1.1', 'client', 500)
    }
    expect(afterRelaunch(pending, 'app.hexbot.desktop', 'full', '0.1.6', now)).toEqual({
      notApplied: entry('0.1.7', 'full'),
      keep: { 'app.hexbot.client': entry('0.1.7', 'client') }
    })
    expect(afterRelaunch(pending, 'app.hexbot.desktop', 'full', '0.1.7', now).notApplied).toBeNull()
    expect(afterRelaunch(undefined, 'app.hexbot.desktop', 'full', '0.1.7', now)).toEqual({
      notApplied: null,
      keep: {}
    })
  })
})
