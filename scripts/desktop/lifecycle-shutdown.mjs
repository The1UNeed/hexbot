// Test harness only. Playwright attaches Node's inspector to the main process.
// Detach it at native will-quit, without making another application Quit call.
export function instrumentShutdown({ app }, file) {
  const fs = process.getBuiltinModule('fs')
  const inspector = process.getBuiltinModule('inspector')
  const trace = (event, details = {}) => fs.appendFileSync(file,
    JSON.stringify({ event, time: Date.now(), ...details }) + '\n')
  globalThis.hexbotLifecycleTrace = trace
  trace('instrumented', { electron: process.versions.electron, node: process.versions.node })
  for (const event of ['window-all-closed', 'before-quit', 'will-quit', 'quit'])
    app.on(event, () => trace(event))
  app.once('will-quit', () => {
    trace('inspector-detach', { active: Boolean(inspector.url()) })
    inspector.close()
  })
  process.once('exit', code => trace('process-exit', { code }))
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
