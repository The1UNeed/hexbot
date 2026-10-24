// Test-only observation of Playwright's existing protocol logger. No protocol
// command, second inspector session, retry or transport replacement is added.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { appendFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { format, stripVTControlCharacters } from 'node:util'
import { SHUTDOWN_TRACE_ENV, acknowledgeInstrumentation, assertSingleInstall, observeShutdown, requestShutdown, waitForTrace } from './lifecycle-shutdown.mjs'

export function protocolSummary(message, direction) {
  const context = message.params?.context
  return {
    direction, id: message.id, method: message.method,
    session: message.sessionId?.slice(0, 128),
    executionContextId: message.params?.executionContextId ?? message.params?.contextId ?? context?.id,
    contextName: context?.name?.slice(0, 128), isDefault: context?.auxData?.isDefault,
    uniqueId: context?.uniqueId?.slice(0, 128),
    objectId: message.params?.objectId?.slice(0, 128),
    awaitPromise: message.params?.awaitPromise, returnByValue: message.params?.returnByValue,
    resultObjectId: message.result?.result?.objectId?.slice(0, 128),
    resultType: message.result?.result?.type, resultSubtype: message.result?.result?.subtype,
    error: message.error && { code: message.error.code, message: message.error.message?.slice(0, 512) },
    exception: message.result?.exceptionDetails?.text?.slice(0, 512)
  }
}

export async function withProtocolTrace(debug, file, phase, action) {
  let count = 0, dropped = 0, records = 0, omitted = 0
  let recordingError
  const pending = new Set()
  const record = (event, details = {}) => {
    try {
      if (records++ < 512 || event === 'protocol-summary') appendFileSync(file, JSON.stringify({ time: Date.now(), phase: phase(), event, ...details }) + '\n')
      else omitted++
    } catch (error) { recordingError ??= error }
  }
  const oldLog = debug.log
  const namespaces = debug.disable()
  debug.enable('pw:protocol')
  debug.log = (...args) => {
    const text = stripVTControlCharacters(format(...args))
    const match = /(?:SEND ►|◀ RECV) (\{.*\})/.exec(text)
    if (!match) return
    try {
      const message = JSON.parse(match[1])
      const sent = text.includes('SEND ►')
      const key = `${message.sessionId ?? ''}:${message.id}`
      if (sent && message.method?.startsWith('Runtime.')) {
        if (pending.size < 256) pending.add(key)
        else { dropped++; return }
      } else if (!message.method?.startsWith('Runtime.') && !pending.delete(key)) return
      if (count++ < 256) record('protocol', protocolSummary(message, sent ? 'send' : 'receive'))
      else dropped++
    } catch { record('unparsed-protocol', { bytes: Buffer.byteLength(text) }) }
  }
  let primary
  try { return await action(record) }
  catch (error) {
    primary = error
    record('action-failure', { message: String(error).slice(0, 1024) })
    throw error
  }
  finally {
    record('protocol-summary', { count, dropped, omitted })
    debug.log = oldLog
    debug.enable(namespaces)
    // A logging failure must not replace the original protocol/application error.
    if (recordingError && !primary) throw recordingError
  }
}

export async function instrumentationControl({ electron, debug, executablePath, root, artifacts, environment, preload }) {
  let phase = 'setup'
  return withProtocolTrace(debug, join(artifacts, 'instrumentation-control.jsonl'), () => phase, async record => {
    const failures = []
    // Fixed module/phase controls, each with one preloaded instrumentation.
    // Full uses ESM; CJS is the baseline. The ready case is not a retry. Busy
    // controls hold the main thread at entry, where an inspector evaluate's
    // result promise could be collected; the preload must not depend on it.
    for (const { esm, ready, busy } of [
      { esm: false }, { esm: true }, { esm: true, ready: true }, { esm: false, busy: true }, { esm: true, busy: true }
    ]) {
      phase = `${esm ? 'esm' : 'cjs'}-${ready ? 'after-first-window' : busy ? 'busy-start' : 'immediate'}`
      const directory = join(root, `instrumentation-${phase}`)
      await mkdir(directory)
      const nativeTrace = join(artifacts, `instrumentation-${phase}-native.jsonl`)
      await writeFile(join(directory, 'package.json'), JSON.stringify({ type: esm ? 'module' : 'commonjs', main: esm ? 'main.mjs' : 'main.cjs' }))
      await writeFile(join(directory, esm ? 'main.mjs' : 'main.cjs'), `
${esm ? "import { app, BrowserWindow } from 'electron'; import fs from 'node:fs';" : "const { app, BrowserWindow } = require('electron'); const fs = require('node:fs');"}
const trace = (event, details = {}) => fs.appendFileSync(${JSON.stringify(nativeTrace)}, JSON.stringify({event,time:Date.now(),pid:process.pid,ready:app.isReady(),electron:process.versions.electron,node:process.versions.node,...details})+'\\n');
app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
trace('main-enter', { instrumented: typeof globalThis.hexbotLifecycleTrace === 'function' });
${busy ? "{ const end = Date.now() + 1500; let keep = []; while (Date.now() < end) { keep.push(new Array(1000).fill(Math.random())); if (keep.length > 2000) keep = [] } trace('busy-end') }" : ''}
app.on('ready',()=>trace('ready'));
app.whenReady().then(()=>{const window=new BrowserWindow({show:false});trace('window-created');return window.loadURL('data:text/html,instrumentation-control')}).then(()=>trace('loaded'));
`)
      const shutdownTrace = join(artifacts, `instrumentation-${phase}-shutdown.jsonl`)
      let app, child, shutdown, closed
      try {
        app = await electron.launch({ executablePath, args: ['-r', preload, directory],
          env: { ...environment, HEXBOT_HOME: directory, [SHUTDOWN_TRACE_ENV]: shutdownTrace }, timeout: 30000 })
        child = app.process()
        closed = once(child, 'close')
        shutdown = observeShutdown(app, child, (event, details) => record(event, details))
        record('launched', { pid: child.pid })
        child.stderr.on('data', data => record('stderr', { bytes: data.length, tail: data.toString().slice(-1024) }))
        if (ready) await app.firstWindow({ timeout: 30000 })
        record('instrumentation-request')
        const deadline = Date.now() + 30000
        const installed = await acknowledgeInstrumentation(shutdownTrace, child, { timeout: deadline - Date.now() })
        record('instrumentation-acknowledged', { pid: installed.pid, ppid: installed.ppid })
        // The app's own first record proves the preload ran before main entry.
        const entry = await waitForTrace(nativeTrace, records => records.find(event => event.event === 'main-enter'),
          { timeout: Math.max(1, deadline - Date.now()), description: 'App main entry' })
        assert.equal(entry?.instrumented, true, 'Instrumentation must exist before the app main entry')
        assert.equal(entry.pid, installed.pid)
      } catch (error) {
        record('control-failure', { message: String(error).slice(0, 1024) })
        failures.push(error)
      } finally {
        if (app) {
          try {
            await requestShutdown(shutdown, () => app.evaluate(({ app }) => { setImmediate(() => app.quit()) }))
            await assertSingleInstall(shutdownTrace)
          } catch (error) {
            record('cleanup-failure', { message: String(error).slice(0, 1024) })
            failures.push(error)
            if (child.exitCode === null && child.signalCode === null) child.kill()
            let timer
            try {
              await Promise.race([closed, new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('Owned control cleanup did not close')), 5000)
              })])
            } catch (cleanup) { failures.push(cleanup) }
            finally { clearTimeout(timer) }
          }
        }
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Instrumentation controls failed', { cause: failures[0] })
  })
}
