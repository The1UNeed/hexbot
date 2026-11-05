import { expect, it } from 'vitest'
import { normalizeUpdateError } from './update-error'
import {
  initialUpdateState,
  onCheckError,
  onCheckStart,
  onDownloadError,
  onInstallError,
  onUpToDate
} from './update-state'

it.each([
  'HttpError: 404 https://updates.hexbot.app/full/win/x64/latest.yml',
  'Cannot find channel "nightly.yml" update info',
  'No feed for this channel',
  'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
])('explains a missing Windows feed: %s', raw => {
  expect(normalizeUpdateError(new Error(raw), 'win32')).toEqual({
    message: 'No update is available for this channel yet.',
    raw
  })
})

it.each(['net::ERR_NAME_NOT_RESOLVED', 'ECONNRESET', 'network unavailable', 'fetch failed'])(
  'explains a Windows network failure: %s',
  raw => {
    expect(normalizeUpdateError(new Error(raw), 'win32')).toEqual({
      message: 'Could not reach the update server. Check your connection and try again.',
      raw
    })
  }
)

it('uses the updater code when the error text has no network details', () => {
  const error = Object.assign(new Error('request failed'), { code: 'ETIMEDOUT' })
  expect(normalizeUpdateError(error, 'win32')).toMatchObject({
    raw: 'request failed',
    message: expect.stringContaining('connection')
  })
})

it.each(['darwin', 'linux'] as const)('keeps %s errors unchanged', platform => {
  expect(normalizeUpdateError(new Error('HTTP 404'), platform)).toBe('HTTP 404')
  expect(normalizeUpdateError('ECONNRESET', platform)).toBe('ECONNRESET')
})

it('preserves other Windows failures and carries raw details through IPC state until retry or success', () => {
  expect(normalizeUpdateError(new Error('Signature mismatch'), 'win32')).toEqual({
    message: 'Signature mismatch',
    raw: 'Signature mismatch'
  })
  const idle = initialUpdateState('1.0.0', 'stable', null)
  const error = normalizeUpdateError(new Error('HTTP 404'), 'win32')
  for (const failed of [
    onCheckError(idle, error, 'now'),
    onDownloadError(idle, error),
    onInstallError(idle, error)
  ]) {
    expect(failed).toMatchObject({
      status: 'error',
      message: 'No update is available for this channel yet.',
      rawError: 'HTTP 404'
    })
    expect(onCheckStart(failed)).toMatchObject({ message: null, rawError: null })
    expect(onUpToDate(failed, 'later')).toMatchObject({ message: null, rawError: null })
  }
})
