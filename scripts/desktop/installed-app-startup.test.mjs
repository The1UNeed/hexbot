import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  captureInstalledApp,
  formatStartupDiagnostic,
  installedStartupFiles,
  startInstalledRuntime,
  startupRedactor
} from './installed-app-startup.mjs'
import { waitForRuntimeJson } from './runtime-file.mjs'

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

test('one Full start precedes readiness and both use the same deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const starting = Promise.withResolvers(),
    ready = Promise.withResolvers()
  const order = []
  let signal
  const waiting = startInstalledRuntime(
    'full',
    () => {
      order.push('start')
      return starting.promise
    },
    value => {
      order.push('ready')
      signal = value
      return ready.promise
    },
    1000
  )
  await flush()
  assert.deepEqual(order, ['start'])
  t.mock.timers.tick(900)
  starting.resolve()
  await flush()
  assert.deepEqual(order, ['start', 'ready'])
  t.mock.timers.tick(100)
  await assert.rejects(waiting, /within 1000 ms/)
  assert.equal(signal.aborted, true)
  ready.reject(new Error('Late readiness failure is still observed'))
  await flush()
})

test('a late start cannot create a readiness watcher; Client never requests Full runtime', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const starting = Promise.withResolvers()
  let starts = 0,
    reads = 0
  const waiting = startInstalledRuntime(
    'full',
    () => {
      starts++
      return starting.promise
    },
    () => {
      reads++
    },
    1000
  )
  await flush()
  t.mock.timers.tick(1000)
  await assert.rejects(waiting, /within 1000 ms/)
  starting.resolve()
  await flush()
  assert.equal(starts, 1)
  assert.equal(reads, 0)
  await startInstalledRuntime(
    'client',
    () => {
      starts++
    },
    () => {
      reads++
    }
  )
  assert.equal(starts, 1)
  assert.equal(reads, 0)
})

test('startup preserves the actual start/readiness error and clears the deadline after success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const phase of ['start', 'ready']) {
    const error = new Error(`${phase} failed`)
    await assert.rejects(
      startInstalledRuntime(
        'full',
        () => {
          if (phase === 'start') throw error
        },
        () => {
          throw error
        }
      ),
      received => received === error
    )
  }
  const state = { port: 1234 }
  assert.equal(
    await startInstalledRuntime(
      'full',
      () => undefined,
      () => state
    ),
    state
  )
  t.mock.timers.tick(300_000)
})

test('startup cancellation closes the real readiness watcher and removes its abort listener', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot installed startup '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const controller = new AbortController()
  const failure = new Error('shared startup deadline')
  let closed = false
  const pending = waitForRuntimeJson(
    join(root, 'state.json'),
    value => value.port,
    300_000,
    () =>
      Object.assign(new EventEmitter(), {
        close() {
          closed = true
        }
      }),
    { signal: controller.signal }
  )
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1)
  controller.abort(failure)
  await assert.rejects(pending, received => received === failure)
  assert.equal(closed, true)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.throws(
    () =>
      waitForRuntimeJson(
        join(root, 'state.json'),
        () => true,
        300_000,
        () => assert.fail('pre-aborted readiness must not watch'),
        { signal: controller.signal }
      ),
    received => received === failure
  )
})

test('bounded app output redacts split credentials, pairing codes and URL secrets and removes listeners', () => {
  const child = { stdout: new EventEmitter(), stderr: new EventEmitter() }
  const secret = 'secret-with-"quote-and-\\slash'
  const redact = startupRedactor({ API_KEY: secret })
  const capture = captureInstalledApp(child, redact)
  child.stdout.emit('data', Buffer.from(secret.slice(0, 8)))
  child.stdout.emit('data', Buffer.from(secret.slice(8) + '\nPairing code: 123456\n'))
  child.stderr.emit(
    'data',
    Buffer.from(
      'https://user:pass@example.com/login?code=secret-code&anything=secret-value#secret-fragment\nBearer bearer-secret\ntoken=assigned-secret\n{"deviceToken":"json-secret","pairing_code":"json-pair-code"}\n'
    )
  )
  const snapshot = JSON.stringify(capture.snapshot())
  for (const value of [
    secret,
    '123456',
    'user:pass',
    'secret-code',
    'secret-value',
    'secret-fragment',
    'bearer-secret',
    'assigned-secret',
    'json-secret',
    'json-pair-code'
  ])
    assert(!snapshot.includes(value), value)
  assert(!redact(JSON.stringify({ message: secret })).includes(JSON.stringify(secret).slice(1, -1)))
  child.stdout.emit('data', Buffer.from('x'.repeat(20000) + '\nsafe line\n'))
  assert(capture.snapshot().stdout.length <= 8192)
  assert(capture.snapshot().stdout.endsWith('safe line\n'))
  capture.dispose()
  assert.equal(child.stdout.listenerCount('data'), 0)
  assert.equal(child.stderr.listenerCount('data'), 0)
})

test('emitted startup diagnostics redact owned file contents and structured secrets before serialization', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot diagnostic emission '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home'),
    bundle = join(root, 'bundle')
  await mkdir(join(home, 'logs'), { recursive: true })
  await mkdir(bundle)
  const deviceToken = 'synthetic-private-device-value'
  const environmentToken = 'synthetic-env-"quoted"-\\token'
  await writeFile(
    join(home, 'logs/bootstrap.log'),
    JSON.stringify({
      deviceToken,
      message: 'bootstrap reached "selection"',
      environment: environmentToken,
      url: 'https://private-user:private-password@example.com/start?code=private-query#private-fragment'
    }) + '\n'
  )
  await writeFile(
    join(bundle, 'manifest.json'),
    JSON.stringify({
      version: '0.1.5-nightly.20990101.1',
      target: 'win32-x64',
      token: 'unread-auth-value'
    })
  )
  const files = await installedStartupFiles(home, bundle)
  // The same formatter emits baseline, startup status, identity and failure evidence.
  const emitted = formatStartupDiagnostic(
    {
      identity: { isPackaged: true, edition: 'full', version: '0.1.5-nightly.20990101.1' },
      status: {
        state: 'stopped',
        deviceToken: 'structured-private-value',
        credentials: { nested: 'private-credential' }
      },
      files
    },
    startupRedactor({ API_TOKEN: environmentToken })
  )
  for (const secret of [
    deviceToken,
    environmentToken,
    JSON.stringify(environmentToken).slice(1, -1),
    'private-user',
    'private-password',
    'private-query',
    'private-fragment',
    'structured-private-value',
    'private-credential',
    'unread-auth-value'
  ])
    assert(!emitted.includes(secret), `Emitted diagnostic exposed ${secret}`)
  const observed = JSON.parse(emitted)
  assert.equal(observed.identity.isPackaged, true)
  assert.equal(observed.identity.edition, 'full')
  assert.equal(observed.status.state, 'stopped')
  assert.equal(observed.status.deviceToken, '[redacted]')
  assert.equal(observed.status.credentials, '[redacted]')
  assert.equal(observed.files.manifest.version, '0.1.5-nightly.20990101.1')
  assert.equal(observed.files.manifest.target, 'win32-x64')
  const bootstrap = JSON.parse(observed.files.bootstrap)
  assert.equal(bootstrap.deviceToken, '[redacted]')
  assert.equal(bootstrap.environment, '[redacted]')
  assert.equal(bootstrap.message, 'bootstrap reached "selection"')
  assert(bootstrap.url.includes('example.com/start'))
})

test('failure files are bounded, allowlisted identities and cannot follow logs outside the owned home', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot startup files '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home'),
    bundle = join(root, 'bundle'),
    outside = join(root, 'outside')
  for (const path of [join(home, 'logs'), join(home, 'runtime'), bundle, outside])
    await mkdir(path, { recursive: true })
  await writeFile(join(home, 'logs/bootstrap.log'), 'x'.repeat(20000) + '\nlast line\n')
  await writeFile(join(home, 'auth.json'), '{"token":"do-not-read"}')
  await writeFile(
    join(bundle, 'manifest.json'),
    JSON.stringify({
      version: '0.1.5-nightly.20990101.1',
      target: 'win32-x64',
      token: 'do-not-read',
      files: { 'hexbot.exe': 'a'.repeat(64), 'config.json': 'do-not-read' }
    })
  )
  await writeFile(
    join(home, 'runtime/native-current.json'),
    JSON.stringify({
      executable: 'C:\\owned\\hexbot.exe',
      version: '0.1.5-nightly.20990101.1',
      token: 'do-not-read'
    })
  )
  const files = await installedStartupFiles(home, bundle)
  assert.equal(files.manifest.version, '0.1.5-nightly.20990101.1')
  assert.equal(files.manifest.files['hexbot.exe'], 'a'.repeat(64))
  assert.equal(files.bootstrap, 'last line\n')
  assert(!JSON.stringify(files).includes('do-not-read'))
  assert.equal(files.running.error, 'ENOENT')
  await rm(join(home, 'logs'), { recursive: true })
  await writeFile(join(outside, 'bootstrap.log'), 'outside secret')
  await symlink(outside, join(home, 'logs'), process.platform === 'win32' ? 'junction' : 'dir')
  const escaped = await installedStartupFiles(home, bundle)
  assert.match(escaped.bootstrap.error, /escaped/)
  assert(!JSON.stringify(escaped).includes('outside secret'))
})
