import type { InstallOption, Locations, Progress, Track } from './api'

/** The installer's words. Glossary terms only (AGENTS.md); no exclamation marks. */

export const OPTIONS: InstallOption[] = ['headless', 'client', 'full']

export const OPTION_NAME: Record<InstallOption, string> = {
  client: 'Client',
  full: 'Full',
  headless: 'Headless'
}

export const OPTION_SUMMARY: Record<InstallOption, string> = {
  client: 'The desktop app alone. Connects to a daemon on another computer.',
  full: 'The desktop app and the daemon on this computer.',
  headless:
    'The daemon alone, as a background service. Use it from other devices over LAN, Tailscale, or Hex Connect.'
}

export const TRACK_NAME: Record<Track, string> = { nightly: 'Nightly', stable: 'Stable' }

export interface Item {
  label: string
  where: string
}

/** What an option puts on this computer, and where. */
export function optionItems(option: InstallOption, locations: Locations, macos: boolean): Item[] {
  const data = tildify(locations.hexbotHome, locations.home)
  const apps = tildify(locations.apps, locations.home)

  switch (option) {
    case 'headless':
      return [
        { label: 'The daemon, as a background service that starts on its own', where: data },
        {
          label: 'The hexbot command, to pair devices and check on the daemon',
          where: tildify(locations.cli, locations.home)
        },
        { label: 'Python and voice tools for your bots, fetched during setup', where: data }
      ]

    case 'client':
      return [
        {
          label: macos
            ? 'Hexbot Client, the desktop app'
            : 'Hexbot Client, the desktop app, with a menu entry',
          where: apps
        },
        { label: 'Nothing runs in the background', where: '' }
      ]

    case 'full':
      return [
        {
          label: macos ? 'Hexbot, the desktop app' : 'Hexbot, the desktop app, with a menu entry',
          where: apps
        },
        { label: 'The daemon, set up by the app the first time it opens', where: data }
      ]
  }
}

/** What a change removes. The data in ~/.hexbot always stays. */
export function changeNotice(from: InstallOption, to: InstallOption, data: string): string {
  if (from === 'headless' && to === 'full') {
    return 'Nothing is removed. The daemon keeps running as a background service, and the app uses it.'
  }

  const removed =
    from === 'client'
      ? 'Hexbot Client will be removed.'
      : from === 'full'
        ? 'The Hexbot app will be removed.'
        : 'The daemon service on this computer will be stopped and removed.'

  return `${removed} Your Hexbot data stays in ${data}.`
}

export function formatSize(bytes: number): string {
  if (bytes >= 1e9) {
    return `${(bytes / 1e9).toFixed(1)} GB`
  }

  const megabytes = bytes / 1e6

  return `${megabytes < 10 ? Math.max(megabytes, 0.1).toFixed(1) : Math.round(megabytes)} MB`
}

export function tildify(path: string, home: string): string {
  if (path === home) {
    return '~'
  }

  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** The headline for a progress event; the engine's own message goes underneath. */
export function stageLabel(event: Progress, removing: boolean): string {
  switch (event.stage) {
    case 'download':
      return 'Downloading'

    case 'verify':
      // The engine checks the download; `hexbot setup` then verifies the runtime it unpacked.
      return event.message.startsWith('Checking the download')
        ? 'Checking the download'
        : 'Setting up the daemon'

    case 'extract':
      return 'Unpacking'

    case 'copy':

    case 'activate':
      return 'Setting up the daemon'

    case 'uv':
      return 'Preparing code tools'

    case 'python':
      return 'Installing Python for code tools'

    case 'voice':
      return 'Installing voice tools'

    case 'link':
      return 'Adding the hexbot command'

    case 'service':
      return removing ? 'Removing the daemon service' : 'Starting the daemon service'

    case 'install':
      return 'Installing the app'

    case 'remove':
      return 'Removing the app'

    case 'done':
      return 'Finishing'

    default:
      return event.message.replace(/\.$/, '')
  }
}

/**
 * Lines worth keeping after the install: engine warnings, and the hints
 * `hexbot setup` prints when it cannot put the hexbot command on PATH.
 */
export function isNote(event: Progress): boolean {
  return (
    event.stage === 'warning' ||
    (event.stage === 'link' && !event.message.startsWith('CLI installed at'))
  )
}

export interface Friendly {
  detail: null | string
  message: string
}

/**
 * Engine errors are written for the terminal installer. Reword the ones that
 * read oddly in a window and keep the original as the detail.
 */
export function friendlyError(raw: string): Friendly {
  const message = raw.trim()
  const rerun = /,? then run (?:this|the) installer again\./

  if (rerun.test(message)) {
    return { detail: null, message: message.replace(rerun, ', then try again.') }
  }

  if (/Run the installer again\.$/.test(message)) {
    return { detail: null, message: message.replace(/Run the installer again\.$/, 'Try again.') }
  }

  if (message.startsWith('This installer is too old.')) {
    return {
      detail: null,
      message: 'This installer is too old. Download the current one from hexbot.app/download.'
    }
  }

  if (/error sending request|dns error|connection refused|timed out|tcp connect/i.test(message)) {
    return {
      detail: message,
      message: 'Could not reach the update server. Check your connection and try again.'
    }
  }

  if (/^hexbot (setup|service)/.test(message)) {
    return { detail: message, message: 'The daemon could not finish setting up.' }
  }

  return { detail: null, message }
}
