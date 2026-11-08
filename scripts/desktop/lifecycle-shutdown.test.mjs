import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { observeShutdown, requestShutdown } from './lifecycle-shutdown.mjs'

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
