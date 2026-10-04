import type { Detection, InstallResult } from './api'
import { friendlyError, stageLabel } from './copy'
import { type Event, initialState, percentAt, reduce, type State } from './machine'

const locations = {
  apps: '/Applications',
  cli: '/Users/sam/.local/bin/hexbot',
  hexbotHome: '/Users/sam/.hexbot',
  home: '/Users/sam'
}

const fresh: Detection = {
  daemonFiles: false,
  installed: null,
  installerVersion: '0.1.5',
  locations,
  platform: 'macos/aarch64',
  target: 'macos-aarch64'
}

const full: Detection = {
  ...fresh,
  installed: {
    apps: [{ path: '/Applications/Hexbot Nightly.app', managed_by_dpkg: false }],
    option: 'full',
    service: false,
    track: 'nightly',
    version: '0.1.5-nightly.20261004.1'
  }
}

const result: InstallResult = {
  receipt: {
    channel: 'nightly',
    installedAt: '2026-10-04T00:00:00Z',
    option: 'headless',
    paths: [],
    version: '0.1.5-nightly.20261004.1'
  },
  status: { port: 9119, running: true },
  warnings: ['Install bubblewrap for the Auto mode sandbox.']
}

const play = (events: Event[], state: State = initialState) => events.reduce(reduce, state)

describe('screens', () => {
  it('opens on welcome, the installed screen, or the unsupported screen', () => {
    expect(play([{ detection: fresh, type: 'detected' }]).screen.name).toBe('welcome')
    expect(play([{ detection: full, type: 'detected' }]).screen.name).toBe('installed')
    expect(
      play([{ detection: { ...fresh, locations: null, target: null }, type: 'detected' }]).screen
        .name
    ).toBe('unsupported')
  })

  it('walks welcome, choose, and the option page, and back again', () => {
    let state = play([{ detection: fresh, type: 'detected' }, { type: 'begin' }, { type: 'next' }])

    expect(state.screen).toEqual({ name: 'choose', selected: null })

    state = play([{ option: 'client', type: 'select' }, { type: 'next' }], state)
    expect(state.screen).toEqual({ name: 'option', option: 'client' })

    state = play([{ type: 'back' }], state)
    expect(state.screen).toEqual({ name: 'choose', selected: 'client' })
    expect(play([{ type: 'back' }], state).screen.name).toBe('welcome')
  })

  it('installs with progress that never runs backwards, then keeps the warnings', () => {
    let state = play([
      { detection: fresh, type: 'detected' },
      { type: 'begin' },
      { option: 'headless', type: 'select' },
      { type: 'next' },
      { option: 'headless', track: 'nightly', type: 'install' }
    ])

    expect(state.screen).toMatchObject({
      job: { from: null, kind: 'install', option: 'headless', track: 'nightly' },
      name: 'working',
      percent: 0
    })

    const run = state.run

    state = play(
      [
        {
          event: { downloaded: 50, message: 'Downloading Hexbot.', stage: 'download', total: 100 },
          run,
          type: 'progress'
        },
        { event: { message: 'Checking the download.', stage: 'verify' }, run, type: 'progress' },
        {
          event: { message: 'Installing Python for code tools', stage: 'python' },
          run,
          type: 'progress'
        },
        // `hexbot setup` verifies again after the engine; the bar holds still.
        {
          event: { message: 'Verifying the native runtime', stage: 'verify' },
          run,
          type: 'progress'
        },
        {
          event: {
            message: 'Add to your shell profile: export PATH="$HOME/.local/bin:$PATH"',
            stage: 'link'
          },
          run,
          type: 'progress'
        },
        // A late event from an earlier attempt is ignored.
        { event: { message: 'stale', stage: 'done' }, run: run - 1, type: 'progress' }
      ],
      state
    )

    expect(state.screen).toMatchObject({ last: { stage: 'link' }, name: 'working', percent: 92 })

    state = play([{ result, run, type: 'finished' }], state)
    expect(state.screen).toMatchObject({
      name: 'done',
      notes: [
        'Add to your shell profile: export PATH="$HOME/.local/bin:$PATH"',
        'Install bubblewrap for the Auto mode sandbox.'
      ]
    })
  })

  it('refreshes detection after a failed change before retry or Back', () => {
    let state = play([
      { detection: full, type: 'detected' },
      { type: 'changeOption' },
      { option: 'client', type: 'select' },
      { type: 'next' },
      { option: 'client', track: 'nightly', type: 'install' }
    ])

    const first = state.run

    state = play(
      [
        {
          message: 'Quit Hexbot Nightly, then run the installer again.',
          run: first,
          type: 'failed'
        }
      ],
      state
    )
    expect(state.screen.name).toBe('refreshing')
    expect(reduce(state, { type: 'back' })).toBe(state)
    expect(reduce(state, { type: 'retry' })).toBe(state)
    state = reduce(state, { detection: full, type: 'detected' })
    expect(state.screen).toMatchObject({
      job: { from: 'full', kind: 'install', option: 'client' },
      message: 'Quit Hexbot Nightly, then run the installer again.',
      name: 'error',
      origin: { name: 'installed' }
    })

    state = play([{ type: 'retry' }], state)
    expect(state.run).toBe(first + 2)
    expect(state.screen).toMatchObject({ job: { from: 'full', option: 'client' }, name: 'working' })

    // A partial change can leave a different option on disk.
    state = play([{ message: 'nope', run: state.run, type: 'failed' }, { type: 'back' }], state)
    expect(state.screen.name).toBe('refreshing')
    state = play([{ detection: fresh, type: 'detected' }, { type: 'back' }], state)
    expect(state.screen).toEqual({ name: 'welcome' })
  })

  it('prefers the message hexbot setup reported over the exit status', () => {
    let state = play([
      { detection: fresh, type: 'detected' },
      { type: 'begin' },
      { option: 'headless', type: 'select' },
      { type: 'next' },
      { option: 'headless', track: 'stable', type: 'install' }
    ])

    state = play(
      [
        {
          event: { message: 'Python could not be installed', stage: 'error' },
          run: state.run,
          type: 'progress'
        },
        { message: 'hexbot setup --activate --json failed: exit 1', run: state.run, type: 'failed' }
      ],
      state
    )
    expect(state.screen).toMatchObject({ message: 'Python could not be installed', name: 'refreshing' })
  })

  it('changes from the installed option and never offers it again', () => {
    const state = play([{ detection: full, type: 'detected' }, { type: 'changeOption' }])

    expect(state.screen).toEqual({ name: 'choose', selected: 'headless' })
    expect(play([{ type: 'back' }], state).screen.name).toBe('installed')
  })

  it('updates the installed option in place', () => {
    const state = play([{ detection: full, type: 'detected' }, { type: 'repair' }])

    expect(state.screen).toMatchObject({ job: { kind: 'repair', option: 'full' }, name: 'working' })
  })

  it('keeps data on uninstall unless the box is ticked', () => {
    let state = play([{ detection: full, type: 'detected' }, { type: 'askUninstall' }])

    expect(state.screen).toEqual({ name: 'uninstall', removeData: false })
    expect(play([{ type: 'uninstall' }], state).screen).toMatchObject({
      job: { kind: 'uninstall', removeData: false },
      percent: null
    })

    state = play([{ type: 'toggleRemoveData' }, { type: 'uninstall' }], state)
    expect(state.screen).toMatchObject({ job: { kind: 'uninstall', removeData: true } })
    state = play([{ result: null, run: state.run, type: 'finished' }], state)
    expect(state.screen).toMatchObject({ name: 'done', result: null })
  })

  it('retries a failed detection', () => {
    let state = play([{ message: 'HOME is not set.', run: 0, type: 'failed' }])

    expect(state.screen).toMatchObject({ job: null, name: 'error', origin: null })
    state = play([{ type: 'retry' }], state)
    expect(state.screen.name).toBe('loading')
    expect(state.run).toBe(1)
  })
})

describe('progress', () => {
  it('splits the bar between download and setup by option', () => {
    const half = { downloaded: 1, message: '', stage: 'download', total: 2 }

    expect(percentAt('headless', half)).toBe(20)
    expect(percentAt('full', half)).toBe(40)
    expect(percentAt('full', { message: '', stage: 'install' })).toBe(92)
    expect(percentAt('headless', { message: '', stage: 'unknown' })).toBe(0)

    for (const option of ['full', 'client', 'headless', null] as const) {
      expect(percentAt(option, { message: '', stage: 'done' })).toBe(100)
    }
  })
})

describe('stage labels', () => {
  it('tells the download check from the runtime check', () => {
    expect(stageLabel({ message: 'Checking the download.', stage: 'verify' }, false)).toBe(
      'Checking the download'
    )
    expect(stageLabel({ message: 'Verifying the native runtime', stage: 'verify' }, false)).toBe(
      'Setting up the daemon'
    )
    expect(stageLabel({ message: 'Daemon service removed.', stage: 'service' }, true)).toBe(
      'Removing the daemon service'
    )
  })
})

describe('errors', () => {
  it('rewords terminal advice for a window', () => {
    expect(friendlyError('Quit Hexbot Nightly, then run the installer again.').message).toBe(
      'Quit Hexbot Nightly, then try again.'
    )
    expect(
      friendlyError(
        'Hexbot was installed with a package manager. Remove it with sudo apt remove hexbot, then run this installer again. Your Hexbot data will be kept.'
      ).message
    ).toBe(
      'Hexbot was installed with a package manager. Remove it with sudo apt remove hexbot, then try again. Your Hexbot data will be kept.'
    )
    expect(
      friendlyError('The download checksum does not match. Run the installer again.').message
    ).toBe('The download checksum does not match. Try again.')
    expect(
      friendlyError(
        'error sending request for url (https://updates.hexbot.app/install/stable.json)'
      )
    ).toEqual({
      detail: 'error sending request for url (https://updates.hexbot.app/install/stable.json)',
      message: 'Could not reach the update server. Check your connection and try again.'
    })
  })
})

it('keeps daemon files on the welcome path without offering repair', () => {
  const state = play([{ detection: { ...fresh, daemonFiles: true }, type: 'detected' }])

  expect(state.screen.name).toBe('welcome')
  expect(reduce(state, { type: 'repair' })).toBe(state)
  expect(reduce(state, { type: 'begin' }).screen).toEqual({ name: 'choose', selected: null })
})

it('does not count service removal as the end of a change to Client', () => {
  let state = play([
    { detection: { ...full, installed: { ...full.installed!, service: true } }, type: 'detected' },
    { type: 'changeOption' },
    { option: 'client', type: 'select' },
    { type: 'next' },
    { option: 'client', track: 'stable', type: 'install' }
  ])

  state = reduce(state, {
    event: { message: 'Daemon service removed.', stage: 'service' }, run: state.run, type: 'progress'
  })
  expect(state.screen).toMatchObject({ percent: 0 })
  state = reduce(state, {
    event: { downloaded: 50, message: 'Downloading Hexbot.', stage: 'download', total: 100 },
    run: state.run, type: 'progress'
  })
  expect(state.screen).toMatchObject({ percent: 40 })
})


it('keeps navigation blocked when detection after a failed mutation also fails', () => {
  let state = play([{ detection: full, type: 'detected' }, { type: 'repair' }])

  state = reduce(state, { message: 'Install failed', run: state.run, type: 'failed' })
  state = reduce(state, { message: 'Detection failed', run: state.run, type: 'failed' })
  expect(state.screen).toMatchObject({ job: null, name: 'error', origin: null })
  expect(reduce(state, { type: 'back' })).toBe(state)
  expect(reduce(state, { type: 'retry' }).screen).toEqual({ name: 'loading' })
})

it('retries a failed change using the newly detected option', () => {
  let state = play([
    { detection: full, type: 'detected' }, { type: 'changeOption' },
    { option: 'client', type: 'select' }, { type: 'next' },
    { option: 'client', track: 'stable', type: 'install' }
  ])

  state = reduce(state, { message: 'Install failed', run: state.run, type: 'failed' })
  state = play([
    { detection: { ...full, installed: { ...full.installed!, option: 'client' } }, type: 'detected' },
    { type: 'retry' }
  ], state)
  expect(state.screen).toMatchObject({ job: { from: null, kind: 'install', option: 'client' }, name: 'working' })
})
