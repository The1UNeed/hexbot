import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { stopChild } from './smoke-lifecycle.mjs'

for (const { signal, failure } of [{ signal: 'SIGINT' }, { signal: 'SIGTERM' }, { signal: 'SIGINT', failure: true }]) {
  test(`retained pnpm cleanup survives grouped ${signal}${failure ? ' and preserves a smoke failure' : ''}`, { skip: process.platform === 'win32', timeout: 15000 }, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'hexbot-smoke-signals-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const helper = new URL('./smoke-lifecycle.mjs', import.meta.url).href
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true, scripts: { keep: 'node fixture.mjs' } }))
    await writeFile(path.join(root, 'fixture.mjs'), `
      import { spawn } from 'node:child_process'
      import { once } from 'node:events'
      import { mkdir, open, rm, writeFile } from 'node:fs/promises'
      import { retainUntilStopped, stopChild } from ${JSON.stringify(helper)}
      await mkdir('home'); await mkdir('workspace')
      const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      await once(daemon, 'spawn')
      await writeFile('daemon.pid', String(daemon.pid))
      const retained = retainUntilStopped()
      const alive = setInterval(() => {}, 1000)
      console.log('RETAINED')
      try { await retained.stopped; ${failure ? "throw new Error('Expected smoke failure')" : ''} }
      finally {
        const output = await open('model-requests.json', 'w')
        console.log('CLEANING')
        // Simulate slow artifact I/O while pnpm forwards the process-group signal again.
        await new Promise(resolve => setTimeout(resolve, 100))
        await output.writeFile(JSON.stringify([{ messages: [{ role: 'user', content: 'Hello from native cleanup' }] }]))
        await output.close()
        await stopChild(daemon)
        await rm('home', { recursive: true }); await rm('workspace', { recursive: true })
        clearInterval(alive)
        retained.dispose()
        console.log('CLEANED')
      }
    `)
    const run = spawn('pnpm', ['run', 'keep'], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const closed = once(run, 'close')
    let output = ''
    run.stdout.on('data', chunk => { output += chunk })
    run.stderr.on('data', chunk => { output += chunk })
    t.after(() => {
      try { process.kill(-run.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    })
    await new Promise(resolve => {
      run.stdout.on('data', () => { if (output.includes('RETAINED')) resolve() })
    })
    process.kill(-run.pid, signal)
    await new Promise(resolve => {
      run.stdout.on('data', () => { if (output.includes('CLEANING')) resolve() })
    })
    process.kill(-run.pid, signal)
    const [code] = await closed
    assert.match(output, /CLEANED/)
    if (failure) {
      assert.notEqual(code, 0)
      assert.match(output, /Expected smoke failure/)
    }
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'model-requests.json'), 'utf8')), [
      { messages: [{ role: 'user', content: 'Hello from native cleanup' }] }
    ])
    for (const directory of ['home', 'workspace'])
      await assert.rejects(access(path.join(root, directory)), { code: 'ENOENT' })
    const pid = Number(await readFile(path.join(root, 'daemon.pid'), 'utf8'))
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  })
}

test('stopChild handles a daemon already terminated by a process-group signal', { timeout: 5000 }, async () => {
  const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const exited = once(daemon, 'exit')
  await once(daemon, 'spawn')
  daemon.kill('SIGTERM')
  await exited
  assert.equal(daemon.exitCode, null)
  assert.equal(daemon.signalCode, 'SIGTERM')
  await stopChild(daemon)
  await stopChild(daemon)
})

test('stopChild terminates and reaps a running daemon', { timeout: 5000 }, async () => {
  const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await once(daemon, 'spawn')
  await stopChild(daemon)
  assert.equal(daemon.signalCode, 'SIGTERM')
})
