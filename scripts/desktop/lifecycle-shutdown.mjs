// Test harness only. Playwright attaches Node's inspector to the main process.
// Detach it at native will-quit, without making another application Quit call.
export function instrumentShutdown({ app }, file) {
  const fs = process.getBuiltinModule('fs')
  const inspector = process.getBuiltinModule('inspector')
  const trace = (event, details = {}) => fs.appendFileSync(file,
    JSON.stringify({ event, time: Date.now(), ...details }) + '\n')
  globalThis.hexbotLifecycleTrace = trace
  trace('instrumented', { pid: process.pid, ppid: process.ppid, ready: app.isReady?.(), electron: process.versions.electron, node: process.versions.node })
  for (const event of ['window-all-closed', 'before-quit', 'will-quit', 'quit'])
    app.on(event, () => trace(event))
  app.once('will-quit', () => {
    trace('inspector-detach', { active: Boolean(inspector.url()) })
    inspector.close()
    trace('inspector-detached', { active: Boolean(inspector.url()), resources: process.getActiveResourcesInfo() })
  })
  process.once('exit', code => trace('process-exit', { code, resources: process.getActiveResourcesInfo() }))
}

// Subscribe while the application is live, before any shutdown action. A
// Playwright close is not proof of native exit, and exit is not stdio close.
export function observeShutdown(app, child, record = () => {}) {
  const observed = { appClosed: false, exit: null, processClosed: false }
  const closed = new Promise(resolve => app.once('close', () => {
    observed.appClosed = true
    record('app-close')
    resolve()
  }))
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    observed.exit = { code, signal }
    record('child-exit', observed.exit)
    resolve()
  }))
  const drained = new Promise(resolve => child.once('close', () => {
    observed.processClosed = true
    record('child-close')
    resolve()
  }))
  return {
    requested: false,
    observed,
    async wait(timeout = 5000) {
      let timer
      try {
        await Promise.race([
          Promise.all([closed, exited, drained]),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(
              `Native shutdown did not complete: ${JSON.stringify({ pid: child.pid, ...observed, exitCode: child.exitCode, signal: child.signalCode })}`
            )), timeout)
          })
        ])
        if (observed.exit.code !== 0 || observed.exit.signal !== null)
          throw new Error(`Native shutdown failed: ${JSON.stringify(observed.exit)}`)
        record('shutdown-verified', observed.exit)
      } finally {
        clearTimeout(timer)
      }
    }
  }
}

export async function requestShutdown(state, action) {
  if (state.requested) throw new Error('A shutdown request is already in progress')
  state.requested = true
  const outcome = Promise.resolve().then(action).then(() => undefined, error => error)
  const [error] = await Promise.all([outcome, state.wait()])
  // inspector.close can dispose evaluate before its result reaches the parent.
  // Application errors still fail even if the process independently exited.
  if (error && !/Target.*closed|Execution context.*destroyed|has been closed/i.test(error.message))
    throw error
}

// Stock Electron's default_app runs each `-r` module synchronously before the
// app's main entry (electron default_app/main.ts). Packaged apps ignore `-r`.
// The preload runs the exact instrumentShutdown source above, never a copy.
export const SHUTDOWN_TRACE_ENV = 'HEXBOT_LIFECYCLE_SHUTDOWN_TRACE'

export function instrumentationPreloadSource() {
  return `'use strict';
const file = process.env.${SHUTDOWN_TRACE_ENV};
if (!file) throw new Error('${SHUTDOWN_TRACE_ENV} is required');
(${instrumentShutdown.toString()})({ app: require('electron').app }, file);
`
}

export async function writeInstrumentationPreload(directory) {
  const { writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const file = join(directory, 'lifecycle-preload.cjs')
  await writeFile(file, instrumentationPreloadSource(), { flag: 'wx' })
  return file
}

// Complete JSONL records only. A malformed record is evidence of a problem,
// never skipped.
function traceRecords(text) {
  const complete = text.slice(0, text.lastIndexOf('\n') + 1)
  return complete.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

// The launch-owned trace must start with exactly one install from the
// launched process: POSIX launches Electron directly, while Windows Playwright
// launches it through a shell, so Electron's parent is the tracked process.
// PID metadata attributes the record; it grants no process control.
export function validateInstrumentation(records, child, platform = process.platform) {
  const installs = records.filter(record => record.event === 'instrumented')
  if (installs.length !== 1 || records[0] !== installs[0])
    throw new Error(`Expected one leading instrumentation record, found ${installs.length}`)
  const [record] = installs
  const attributed = platform === 'win32'
    ? record.ppid === child.pid && record.pid !== child.pid
    : record.pid === child.pid
  if (!attributed || record.ready !== false || typeof record.electron !== 'string')
    throw new Error(`Instrumentation record does not match this launch: ${JSON.stringify({ record, tracked: child.pid })}`)
  return record
}

// fs.watch can coalesce a file's creation and its first write into one event
// on macOS, which would lose the completed record. watchFile reports any later
// change through stat, within the same overall deadline.
export async function acknowledgeInstrumentation(file, child, { timeout = 30000, platform = process.platform } = {}) {
  const { readFile } = await import('node:fs/promises')
  const { watchFile, unwatchFile } = await import('node:fs')
  let timer, settle
  const changed = () => settle?.()
  try {
    watchFile(file, { interval: 50 }, changed)
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Instrumentation preload was not acknowledged within ${timeout} ms`)), timeout)
    })
    deadline.catch(() => {}) // observed through Promise.race below
    for (;;) {
      const next = new Promise(resolve => { settle = resolve })
      const text = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
      const records = traceRecords(text)
      if (records.length) return validateInstrumentation(records, child, platform)
      await Promise.race([next, deadline])
    }
  } finally {
    clearTimeout(timer)
    unwatchFile(file, changed)
  }
}

export async function assertSingleInstall(file) {
  const { readFile } = await import('node:fs/promises')
  const installs = traceRecords(await readFile(file, 'utf8')).filter(record => record.event === 'instrumented')
  if (installs.length !== 1) throw new Error(`Expected exactly one instrumentation install, found ${installs.length}`)
}
