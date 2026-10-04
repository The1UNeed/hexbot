import type { Detection, InstallOption, InstallResult, Progress, Track } from './api'
import { isNote } from './copy'

/**
 * The installer's screens as a pure reducer. App.tsx runs the side effects:
 * it calls the engine when a job starts and feeds the results back as events.
 */

export type Job =
  | { from: InstallOption | null; kind: 'install'; option: InstallOption; track: Track }
  | { kind: 'repair'; option: InstallOption }
  | { kind: 'uninstall'; option: InstallOption | null; removeData: boolean }

export type Screen =
  | { job: Job | null; message: string; name: 'error'; origin: null | Screen }
  | { job: Job; name: 'done'; notes: string[]; result: InstallResult | null }
  | {
      error: null | string
      job: Job
      last: null | Progress
      name: 'working'
      notes: string[]
      origin: Screen
      percent: null | number
      run: number
    }
  | { name: 'choose'; selected: InstallOption | null }
  | { name: 'installed' }
  | { name: 'loading' }
  | { job: Job; message: string; name: 'refreshing' }
  | { name: 'option'; option: InstallOption }
  | { name: 'uninstall'; removeData: boolean }
  | { name: 'unsupported' }
  | { name: 'welcome' }

export interface State {
  detection: Detection | null
  /** Bumped for every job and every detection, so effects run once per attempt. */
  run: number
  screen: Screen
}

export type Event =
  | { detection: Detection; type: 'detected' }
  | { event: Progress; run: number; type: 'progress' }
  | { message: string; run: number; type: 'failed' }
  | { option: InstallOption; track: Track; type: 'install' }
  | { option: InstallOption; type: 'select' }
  | { result: InstallResult | null; run: number; type: 'finished' }
  | { type: 'askUninstall' }
  | { type: 'back' }
  | { type: 'begin' }
  | { type: 'changeOption' }
  | { type: 'next' }
  | { type: 'repair' }
  | { type: 'retry' }
  | { type: 'uninstall' }
  | { type: 'toggleRemoveData' }

export const initialState: State = { detection: null, run: 0, screen: { name: 'loading' } }

/** Where a screen's Back (and Escape) leads, if anywhere. */
export function backOf(state: State): null | Screen {
  const { screen } = state

  switch (screen.name) {
    case 'choose':
      return state.detection?.installed ? { name: 'installed' } : { name: 'welcome' }

    case 'option':
      return { name: 'choose', selected: screen.option }

    case 'uninstall':
      return { name: 'installed' }

    case 'error':
      return screen.origin

    default:
      return null
  }
}

function start(state: State, job: Job): State {
  const run = state.run + 1

  return {
    ...state,
    run,
    screen: {
      error: null,
      job,
      last: null,
      name: 'working',
      notes: [],
      origin: state.screen,
      percent: job.kind === 'uninstall' ? null : 0,
      run
    }
  }
}

export function reduce(state: State, event: Event): State {
  const { screen } = state
  const packageManaged = state.detection?.installed?.apps.some(app => app.managed_by_dpkg)

  switch (event.type) {
    case 'detected': {
      const { detection } = event

      const landing: Screen = !detection.target
        ? { name: 'unsupported' }
        : detection.installed
          ? { name: 'installed' }
          : { name: 'welcome' }

      if (screen.name === 'refreshing') {
        const installed = detection.installed?.option

        const job = screen.job.kind === 'install'
          ? { ...screen.job, from: installed && installed !== screen.job.option ? installed : null }
          : screen.job

        return {
          ...state,
          detection,
          screen: {
            job: detection.installed?.apps.some(app => app.managed_by_dpkg) ? null : job,
            message: screen.message,
            name: 'error',
            origin: landing
          }
        }
      }

      return {
        ...state,
        detection,
        screen: landing
      }
    }

    case 'begin':
      return screen.name === 'welcome'
        ? { ...state, screen: { name: 'choose', selected: null } }
        : state
    case 'changeOption': {
      const current = state.detection?.installed?.option

      return screen.name === 'installed' && !packageManaged
        ? {
            ...state,
            screen: { name: 'choose', selected: OTHER[current ?? 'full'] }
          }
        : state
    }

    case 'select':
      return screen.name === 'choose'
        ? { ...state, screen: { ...screen, selected: event.option } }
        : state

    case 'next':
      return screen.name === 'choose' && screen.selected
        ? { ...state, screen: { name: 'option', option: screen.selected } }
        : state
    case 'back': {
      const back = backOf(state)

      return back && screen.name !== 'working' ? { ...state, screen: back } : state
    }

    case 'askUninstall':
      return screen.name === 'installed' && !packageManaged
        ? { ...state, screen: { name: 'uninstall', removeData: false } }
        : state

    case 'toggleRemoveData':
      return screen.name === 'uninstall'
        ? { ...state, screen: { ...screen, removeData: !screen.removeData } }
        : state
    case 'install': {
      if (screen.name !== 'option') {
        return state
      }

      const installed = state.detection?.installed?.option ?? null

      return start(state, {
        from: installed && installed !== event.option ? installed : null,
        kind: 'install',
        option: event.option,
        track: event.track
      })
    }

    case 'repair': {
      const option = state.detection?.installed?.option

      return screen.name === 'installed' && !packageManaged && option
        ? start(state, { kind: 'repair', option })
        : state
    }

    case 'uninstall':
      return screen.name === 'uninstall'
        ? start(state, {
            kind: 'uninstall',
            option: state.detection?.installed?.option ?? null,
            removeData: screen.removeData
          })
        : state
    case 'progress': {
      if (screen.name !== 'working' || screen.run !== event.run) {
        return state
      }

      const progress = event.event

      if (progress.stage === 'error') {
        return { ...state, screen: { ...screen, error: progress.message } }
      }

      return {
        ...state,
        screen: {
          ...screen,
          last: progress.stage === 'warning' ? screen.last : progress,
          notes: isNote(progress) ? addNote(screen.notes, progress.message) : screen.notes,
          percent:
            screen.percent === null
              ? null
              : Math.max(screen.percent, percentAt(target(screen.job), progress))
        }
      }
    }

    case 'finished':
      return screen.name === 'working' && screen.run === event.run
        ? {
            ...state,
            screen: {
              job: screen.job,
              name: 'done',
              notes: (event.result?.warnings ?? []).reduce(addNote, screen.notes),
              result: event.result
            }
          }
        : state

    case 'failed':
      if (event.run !== state.run) {
        return state
      }

      if (screen.name === 'loading' || screen.name === 'refreshing') {
        return {
          ...state,
          screen: {
            job: null,
            message: screen.name === 'refreshing'
              ? `${screen.message} Could not check the installation: ${event.message}`
              : event.message,
            name: 'error',
            origin: null
          }
        }
      }

      return screen.name === 'working' && screen.run === event.run
        ? {
            ...state,
            detection: null,
            run: state.run + 1,
            screen: {
              job: screen.job,
              // `hexbot setup --json` reports what went wrong before it exits.
              message: screen.error ?? event.message,
              name: 'refreshing'
            }
          }
        : state

    case 'retry':
      if (screen.name !== 'error') {
        return state
      }

      if (!screen.job) {
        return { ...state, run: state.run + 1, screen: { name: 'loading' } }
      }

      return start({ ...state, screen: screen.origin ?? { name: 'welcome' } }, screen.job)
  }
}

const OTHER: Record<InstallOption, InstallOption> = {
  client: 'full',
  full: 'headless',
  headless: 'full'
}

function addNote(notes: string[], note: string): string[] {
  return notes.includes(note) ? notes : [...notes, note]
}

/** The option whose files a job downloads, which decides how the bar is split. */
function target(job: Job): InstallOption | null {
  return job.kind === 'uninstall' ? null : job.option
}

/**
 * Share of the bar each stage starts at. The download is measured; after it,
 * each stage moves the bar to a fixed mark, so it never creeps or runs back.
 * Headless spends longer after the download, fetching Python and voice tools.
 */
const STAGES: Record<'app' | 'headless', [string, number][]> = {
  app: [
    ['download', 80],
    ['verify', 6],
    ['extract', 6],
    ['install', 4],
    ['service', 2],
    ['remove', 2]
  ],
  headless: [
    ['download', 40],
    ['verify', 2],
    ['extract', 3],
    ['copy', 3],
    ['activate', 2],
    ['uv', 5],
    ['python', 22],
    ['voice', 15],
    ['link', 2],
    ['service', 4],
    ['remove', 2]
  ]
}

export function percentAt(option: InstallOption | null, event: Progress): number {
  if (event.stage === 'done') {
    return 100
  }

  if (option === 'client' && event.stage === 'service') {
    return 0
  }

  const stages = STAGES[option === 'headless' ? 'headless' : 'app']

  if (event.stage === 'download') {
    const total = event.total ?? 0
    const share = total > 0 ? Math.min(1, (event.downloaded ?? 0) / total) : 0

    return Math.floor(stages[0]![1] * share)
  }

  let before = 0

  for (const [stage, weight] of stages) {
    if (stage === event.stage) {
      return before
    }

    before += weight
  }

  return 0
}
