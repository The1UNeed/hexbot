import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import semver from 'semver'
import { bootstrap } from './backend/bootstrap'
import type { DaemonManager } from './backend/manager'
import { requireRuntime } from './edition'
import { hexbotHome, runtimeDir } from './backend/paths'
import { errorMessage, log } from './log'
import { runRemoteUpdate, type UpdateState } from './updater'

// A client newer than the daemon on this machine can ask the daemon to
// update. When the app runs the daemon, the daemon prints
// HEXBOT_UPDATE_REQUESTED (backend/manager.ts) and the app does the work
// here. Progress goes to <home>/runtime/update-status.json, which the daemon
// reads back for `hexbot.update.status` (backend/hexbot-core/src/services.rs),
// because the app has no channel to the daemon of its own. On success the app
// relaunches and the client sees the daemon come back on the new version.
export const updateStatusFile = (): string => join(runtimeDir(), 'update-status.json')

export type RemoteStatus =
  'checking' | 'downloading' | 'installing' | 'failed' | 'up-to-date' | 'ignored'

export function remoteStatus(state: UpdateState): RemoteStatus | null {
  switch (state.status) {
    case 'checking':
      return 'checking'
    case 'available':
    case 'downloading':
      return 'downloading'
    case 'downloaded':
    case 'installing':
      return 'installing'
    case 'error':
      return 'failed'
    case 'up-to-date':
      return 'up-to-date'
    default:
      return null
  }
}

async function writeStatus(
  status: RemoteStatus,
  extra: { percent?: number | null; message?: string | null; version?: string | null } = {}
): Promise<void> {
  try {
    await mkdir(runtimeDir(), { recursive: true })
    await writeFile(
      updateStatusFile(),
      `${JSON.stringify({ status, percent: null, message: null, version: null, ...extra, at: new Date().toISOString() })}\n`
    )
  } catch (error) {
    log.warn(`could not write ${updateStatusFile()}: ${errorMessage(error)}`)
  }
}

let running = false

function failureMessages(error: unknown, seen = new Set<unknown>()): string[] {
  if (seen.has(error)) return []
  seen.add(error)
  const messages = [errorMessage(error)]
  if (error instanceof Error && error.cause !== undefined)
    messages.push(...failureMessages(error.cause, seen))
  if (error instanceof AggregateError)
    for (const nested of error.errors) messages.push(...failureMessages(nested, seen))
  return messages
}

function satisfies(version: string, requested: string): boolean {
  if (!semver.valid(version) || !semver.valid(requested)) return false
  if (
    semver.prerelease(version)?.[0] === 'nightly' &&
    semver.prerelease(requested)?.[0] === 'nightly'
  )
    return semver.gte(version, requested)
  const base = (value: string) =>
    `${semver.major(value)}.${semver.minor(value)}.${semver.patch(value)}`
  return semver.gte(base(version), base(requested))
}

export async function handleDaemonUpdateRequest(
  requested: string,
  daemon?: Pick<DaemonManager, 'start'>
): Promise<void> {
  if (running) return
  running = true
  log.info(`daemon asked for an app update to ${requested} (home ${hexbotHome()})`)
  let writes = Promise.resolve()
  let terminal = false
  let version: string | null = null
  const failures: string[] = []
  try {
    await rm(updateStatusFile(), { force: true })
    const result = await runRemoteUpdate(state => {
      if (terminal) return
      if (state.status === 'error' && state.message) failures.push(state.message)
      version = state.downloadedVersion ?? state.availableVersion ?? version
      const status = remoteStatus(state)
      if (status)
        writes = writes.then(() =>
          writeStatus(status, {
            percent: state.percent,
            message: state.message,
            version: state.downloadedVersion ?? state.availableVersion
          })
        )
    })
    if (result.outcome !== 'installing' && daemon) {
      if (result.message) failures.push(result.message)
      requireRuntime('Updating the local daemon')
      await writes
      await writeStatus('installing', { version: requested })
      await daemon.start(async () => {
        const activation = await bootstrap(() => undefined)
        if (!activation || !satisfies(activation.version, requested))
          throw new Error('The verified runtime does not satisfy the requested daemon version')
        version = activation.version
        return activation
      })
      terminal = true
      await writes
      await writeStatus('up-to-date', {
        version,
        message: 'The daemon is ready on the selected runtime.'
      })
      return
    }
    terminal = true
    await writes
    if (result.outcome === 'installing') await writeStatus('installing', { version })
    else {
      log.warn(`remote update ended: ${result.outcome} ${result.message ?? ''}`)
      await writeStatus(result.outcome === 'up-to-date' ? 'up-to-date' : 'failed', {
        message:
          [...new Set([...failures, ...(result.message ? [result.message] : [])])].join('\n') ||
          null
      })
    }
  } catch (error) {
    terminal = true
    await writes
    const message = [...new Set([...failures, ...failureMessages(error)])].join('\n')
    log.warn(`remote update failed: ${message}`)
    await writeStatus('failed', { message })
  } finally {
    running = false
  }
}
