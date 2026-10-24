import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  SHUTDOWN_TRACE_ENV, acknowledgeInstrumentation, assertSingleInstall, instrumentShutdown,
  instrumentationPreloadSource, observeShutdown, requestShutdown, validateInstrumentation, waitForTrace, writeInstrumentationPreload
} from './lifecycle-shutdown.mjs'

function fixture() {
  const app = new EventEmitter()
  const child = Object.assign(new EventEmitter(), { pid: 1, exitCode: null, signalCode: null })
  const state = observeShutdown(app, child)
  const finish = (code = 0, signal = null) => {
    child.exitCode = code
    child.signalCode = signal
    child.emit('exit', code, signal)
    app.emit('close')
    child.emit('close', code, signal)
  }
  return { state, finish }
}

test('shutdown observes events before one request, including debug disposal', async () => {
  const { state, finish } = fixture()
  let requests = 0
  await requestShutdown(state, () => {
    requests++
    finish()
    throw new Error('Target page, context or browser has been closed')
  })
  assert.equal(requests, 1)
  assert.deepEqual(state.observed, { appClosed: true, exit: { code: 0, signal: null }, processClosed: true })
  await assert.rejects(requestShutdown(state, () => requests++), /already in progress/)
  assert.equal(requests, 1)
})

test('shutdown refuses crashes, signals and non-debug action errors', async () => {
  for (const [code, signal] of [[1, null], [3221225477, null], [null, 'SIGTERM']]) {
    const { state, finish } = fixture()
    await assert.rejects(requestShutdown(state, () => finish(code, signal)), /Native shutdown failed/)
  }
  const { state, finish } = fixture()
  await assert.rejects(requestShutdown(state, () => {
    finish()
    throw new Error('Native menu action failed')
  }), /Native menu action failed/)
})

test('process exit without app/stdio close cannot satisfy shutdown', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 2, exitCode: 0, signalCode: null })
  const state = observeShutdown(new EventEmitter(), child)
  child.emit('exit', 0, null)
  await assert.rejects(state.wait(1), /Native shutdown did not complete/)
})

test('an attached inspector holds exit; the native will-quit hook detaches it without another Quit', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-inspector-shutdown-'))
  const helper = new URL('./lifecycle-shutdown.mjs', import.meta.url).href
  try {
    for (const detach of [false, true]) {
      const trace = join(root, `${detach}.jsonl`)
      const script = `
        import { EventEmitter } from 'node:events';
        import { instrumentShutdown } from ${JSON.stringify(helper)};
        const app = new EventEmitter();
        instrumentShutdown({ app }, ${JSON.stringify(trace)});
        process.on('message', message => {
          if (message !== 'shutdown') throw new Error('Unexpected request');
          process.disconnect();
          ${detach ? "app.emit('will-quit');" : ''}
        });
        process.send('ready');
      `
      const child = spawn(process.execPath, ['--inspect=0', '--input-type=module', '-e', script], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      })
      const exited = once(child, 'exit')
      const ready = once(child, 'message')
      let stderr = ''
      let resolveEndpoint, resolveWaiting
      const endpoint = new Promise(resolve => { resolveEndpoint = resolve })
      const waiting = new Promise(resolve => { resolveWaiting = resolve })
      child.stderr.on('data', data => {
        stderr += data
        const url = stderr.match(/ws:\/\/[^\s]+/)
        if (url) resolveEndpoint(url[0])
        if (stderr.includes('Waiting for the debugger to disconnect')) resolveWaiting()
      })
      let socket
      try {
        socket = new WebSocket(await endpoint)
        await once(socket, 'open')
        const enabled = new Promise(resolve => socket.addEventListener('message', event => {
          if (JSON.parse(event.data).id === 1) resolve()
        }))
        socket.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }))
        await enabled
        assert.equal((await ready)[0], 'ready')
        const disconnected = once(socket, 'close')
        child.send('shutdown')
        if (!detach) {
          await waiting
          assert.equal(child.exitCode, null, 'Attached inspector holds an otherwise finished process')
          socket.close()
        }
        await disconnected
        assert.deepEqual(await exited, [0, null], stderr)
        const events = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse)
        assert.equal(events.filter(event => event.event === 'inspector-detach').length, Number(detach))
        const detached = events.find(event => event.event === 'inspector-detached')
        if (detach) {
          assert.equal(detached.active, false)
          assert(Array.isArray(detached.resources))
        } else assert.equal(detached, undefined)
        assert.equal(events.filter(event => event.event === 'process-exit' && event.code === 0).length, 1)
      } finally {
        socket?.close()
        if (child.exitCode === null && child.signalCode === null) {
          child.kill()
          await exited
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the launch preload runs the exact shared instrumentation before an app entry', async () => {
  assert(instrumentationPreloadSource().includes(instrumentShutdown.toString()))
  const root = await mkdtemp(join(tmpdir(), 'hexbot-preload-'))
  try {
    // A stub electron resolved beside the preload, as default_app resolves it.
    await mkdir(join(root, 'node_modules/electron'), { recursive: true })
    await writeFile(join(root, 'node_modules/electron/index.js'),
      "Object.defineProperty(process.versions, 'electron', { value: '42.11.3', enumerable: true }); const { EventEmitter } = require('node:events'); const app = new EventEmitter(); app.isReady = () => false; module.exports = { app }")
    const preload = await writeInstrumentationPreload(root)
    await assert.rejects(writeInstrumentationPreload(root), { code: 'EEXIST' })
    const trace = join(root, 'shutdown.jsonl')
    const child = spawn(process.execPath, ['-r', preload, '-e',
      "process.stdout.write(String(typeof globalThis.hexbotLifecycleTrace === 'function'))"],
    { cwd: root, env: { ...process.env, [SHUTDOWN_TRACE_ENV]: trace, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'inherit'] })
    let entry = ''
    child.stdout.on('data', data => { entry += data })
    const [code] = await once(child, 'exit')
    assert.equal(code, 0)
    assert.equal(entry, 'true', 'instrumentation exists when the entry script starts')
    const record = validateInstrumentation(
      (await readFile(trace, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)), child, 'linux')
    assert.equal(record.ready, false)
    assert.equal(record.ppid, process.pid)
    await assertSingleInstall(trace)

    const missing = spawn(process.execPath, ['-r', preload, '-e', ''], {
      cwd: root, env: { ...process.env, [SHUTDOWN_TRACE_ENV]: '', NODE_OPTIONS: '' }, stdio: 'ignore'
    })
    assert.notEqual((await once(missing, 'exit'))[0], 0, 'a missing trace path fails the launch')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('instrumentation acknowledgement attributes one fresh record and refuses the rest', async () => {
  const record = { event: 'instrumented', pid: 20, ppid: 10, ready: false, electron: '42.11.3' }
  assert.equal(validateInstrumentation([record], { pid: 20 }, 'darwin'), record)
  assert.equal(validateInstrumentation([record], { pid: 10 }, 'win32'), record)
  for (const [records, child, platform] of [
    [[], { pid: 20 }, 'darwin'],
    [[record, record], { pid: 20 }, 'darwin'],
    [[{ event: 'before-quit' }, record], { pid: 20 }, 'darwin'],
    [[record], { pid: 21 }, 'darwin'],
    [[record], { pid: 20 }, 'win32'],
    [[{ ...record, ready: true }], { pid: 20 }, 'darwin']
  ]) assert.throws(() => validateInstrumentation(records, child, platform))

  const root = await mkdtemp(join(tmpdir(), 'hexbot-acknowledge-'))
  try {
    await assert.rejects(acknowledgeInstrumentation(join(root, 'missing.jsonl'), { pid: 20 }, { timeout: 50, platform: 'darwin' }),
      /not acknowledged within 50 ms/)
    const malformed = join(root, 'malformed.jsonl')
    await writeFile(malformed, '{not json\n')
    await assert.rejects(acknowledgeInstrumentation(malformed, { pid: 20 }, { platform: 'darwin' }), SyntaxError)
    // A record that arrives after the wait starts is observed through a file event.
    const late = join(root, 'late.jsonl')
    const pending = acknowledgeInstrumentation(late, { pid: 20 }, { timeout: 5000, platform: 'darwin' })
    await appendFile(late, JSON.stringify(record).slice(0, 10))
    await appendFile(late, JSON.stringify(record).slice(10) + '\n')
    assert.deepEqual(await pending, record)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test('main entry can follow preload acknowledgement within the remaining shared deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-main-entry-'))
  try {
    const trace = join(root, 'native.jsonl')
    const select = records => records.find(record => record.event === 'main-enter')
    const deadline = Date.now() + 5000
    const shutdown = join(root, 'shutdown.jsonl')
    await writeFile(shutdown, JSON.stringify({ event: 'instrumented', pid: 20, ready: false, electron: '42.11.3' }) + '\n')
    await acknowledgeInstrumentation(shutdown, { pid: 20 }, { timeout: deadline - Date.now(), platform: 'darwin' })
    const pending = waitForTrace(trace, select, { timeout: deadline - Date.now(), description: 'App main entry' })
    await appendFile(trace, JSON.stringify({ event: 'ready' }) + '\n')
    // A complete unrelated record and partial entry must not count as entry.
    await appendFile(trace, '{"event":"main-enter",')
    await appendFile(trace, '"instrumented":true}\n')
    assert.deepEqual(await pending, { event: 'main-enter', instrumented: true })
    await assert.rejects(waitForTrace(join(root, 'missing'), select, { timeout: 20, description: 'App main entry' }),
      /App main entry was not acknowledged within 20 ms/)
    await writeFile(trace, '{bad json}\n')
    await assert.rejects(waitForTrace(trace, select), SyntaxError)
  } finally { await rm(root, { recursive: true, force: true }) }
})
