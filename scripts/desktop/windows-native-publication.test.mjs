import assert from 'node:assert/strict'
import { channel } from 'node:diagnostics_channel'
import { publicationObserver } from './windows-publication-observer.mjs'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { getSystemErrorMap, promisify } from 'node:util'
import { NODE_VERSION, publishNativeRuntime, standaloneNode } from './native-runtime.mjs'

test('pinned Windows Node/Pi version-process exit permits verified directory publication',
  { skip: process.platform !== 'win32', timeout: 180_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'hexbot real publication π '))
    let observer, observed, primary
    const failed = ({ staging, destination, versionProbe, error }) => {
      observed = observer.observe(staging, destination, versionProbe, error)
        .then(result => ({ ...result, note: 'Read-only post-failure observations, not the original MoveFileExW error.' }),
          diagnostic => ({ error: diagnostic.message, originalCode: error.code }))
    }
    const failures = channel('hexbot.native-publication-failed')
    try {
      observer = await publicationObserver()
      console.log('Publication observer ready:', JSON.stringify(observer.ready))
      failures.subscribe(failed)
      const node = await standaloneNode(root, 'win32', 'x64')
      const staging = join(root, 'staged')
      await mkdir(staging)
      await cp(node, join(staging, 'node.exe'))
      // Provisioned by the preceding real scheduler probe using the pinned lock.
      // Copy its actual Pi imports into staging to exercise loaded native modules.
      await cp(resolve('backend/pi-runtime'), join(staging, 'pi'), { recursive: true, dereference: true })
      const expected = JSON.parse(await readFile(join(staging, 'pi/package.json'), 'utf8')).dependencies['@earendil-works/pi-coding-agent']
      const marker = JSON.stringify({ node: NODE_VERSION, pi: expected })
      await writeFile(join(staging, 'manifest.json'), marker)
      const user = join(root, 'isolated user')
      await mkdir(user)
      let current = staging
      // Each round is a distinct publication after an explicit successful child
      // close, not a retry of a failed rename. Any failure ends the test.
      for (let round = 0; round < 3; round++) {
        const promise = promisify(execFile)(join(current, 'node.exe'),
          [join(current, 'pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js'), '--version'],
          { cwd: current, windowsHide: true, timeout: 20_000, env: { ...process.env,
            HOME: user, USERPROFILE: user, APPDATA: user, LOCALAPPDATA: user, PI_CODING_AGENT_DIR: join(user, 'pi'),
          } })
        const child = promise.child
        const lifecycle = { pid: child.pid, cwd: current, round, node: NODE_VERSION }
        child.once('exit', (code, signal) => { lifecycle.exit = { code, signal } })
        child.once('close', (code, signal) => { lifecycle.close = { code, signal } })
        const { stdout } = await promise
        assert.equal(stdout.trim(), expected)
        assert.deepEqual(lifecycle.exit, { code: 0, signal: null })
        assert.deepEqual(lifecycle.close, { code: 0, signal: null })
        console.log('Real staged version process:', JSON.stringify(lifecycle))
        const destination = join(root, `published-${round}`)
        await publishNativeRuntime(current, destination, lifecycle)
        assert.equal(await readFile(join(destination, 'manifest.json'), 'utf8'), marker)
        current = destination
      }
    } catch (error) {
      primary = error
      if (observed) console.error('Immediate publication observation:', JSON.stringify(await observed))
      throw error
    } finally {
      failures.unsubscribe(failed)
      try { await observer?.close() }
      catch (error) { if (!primary) throw error; console.error('Observer cleanup failed:', error.message) }
      try { await rm(root, { recursive: true, force: true }) }
      catch (error) { if (!primary) throw error; console.error('Staging cleanup failed:', error.code, root) }
    }
  })

test('prewarmed publication observation reports a live cwd blocker without changing the failed operation',
  { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
    const { spawn } = await import('node:child_process')
    const { once } = await import('node:events')
    const root = await mkdtemp(join(tmpdir(), 'hexbot observer control π '))
    let observer, child, observed, primary, reportedError
    const failureChannel = channel('hexbot.native-publication-failed')
    const failed = ({ staging, destination, versionProbe, error }) => {
      reportedError = error
      observed = observer.observe(staging, destination, versionProbe, error).catch(error => ({ diagnosticError: error.message }))
    }
    try {
      observer = await publicationObserver()
      const staging = join(root, 'staged'), destination = join(root, 'published')
      await mkdir(staging)
      await writeFile(join(staging, 'manifest.json'), 'verified marker')
      child = spawn(process.execPath, ['-e', "process.stdout.write('ready');process.stdin.resume()"], { cwd: staging, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      const closed = once(child, 'close')
      closed.catch(() => {})
      let stderr = ''
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096) })
      await once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) })
      failureChannel.subscribe(failed)
      let original
      try { await publishNativeRuntime(staging, destination, { pid: child.pid }) }
      catch (error) { original = error }
      const evidence = await observed
      console.log('Immediate held-CWD observation:', JSON.stringify(evidence))
      assert.equal(original, reportedError, 'Publication must rethrow the original error object')
      // Pinned libuv maps access denied to EPERM and sharing violation to EBUSY.
      const mappings = new Map([['EPERM', -4048], ['EBUSY', -4082]])
      assert(mappings.has(original?.code), 'Expected only the pinned Windows sharing/access mappings')
      assert.equal(mappings.get(original.code), original.errno)
      assert.equal(getSystemErrorMap().get(original.errno)?.[0], original.code)
      assert.equal(original.syscall, 'rename')
      assert.equal(original.path, staging)
      assert.equal(original.dest, destination)
      assert.deepEqual(evidence.failure, { ...evidence.failure,
        code: original.code, errno: original.errno, syscall: original.syscall })
      assert.equal(evidence.worker.directories[0].path, staging)
      assert.equal(evidence.worker.directories[0].share, 7)
      assert.equal(evidence.worker.directories[0].deleteError, 32)
      assert.equal(evidence.worker.directories[1].path, destination)
      assert.equal(evidence.worker.directories[1].deleteError, 2)
      assert.equal(evidence.worker.process.pid, child.pid)
      assert.equal(evidence.worker.process.wait, 258) // WAIT_TIMEOUT: the owned child is still live.
      assert.equal(evidence.worker.process.exitCode, 259)
      assert.match(evidence.worker.process.created, /^\d+$/)
      assert.equal(evidence.worker.process.image.toLowerCase(), process.execPath.toLowerCase())
      assert.equal(await readFile(join(staging, 'manifest.json'), 'utf8'), 'verified marker')
      await assert.rejects(readFile(join(destination, 'manifest.json')), { code: 'ENOENT' })
      child.stdin.end()
      assert.deepEqual(await closed, [0, null], stderr)
      // This is the existing release control, not a retry while the holder lives.
      await publishNativeRuntime(staging, destination)
      assert.equal(await readFile(join(destination, 'manifest.json'), 'utf8'), 'verified marker')
    } catch (error) { primary = error; throw error }
    finally {
      failureChannel.unsubscribe(failed)
      if (child && child.exitCode === null) { child.kill(); await once(child, 'close').catch(() => {}) }
      try { await observer?.close() }
      catch (error) { if (!primary) throw error; console.error('Observer cleanup failed:', error.message) }
      try { await rm(root, { recursive: true, force: true }) }
      catch (error) { if (!primary) throw error; console.error('Observer fixture cleanup failed:', error.code) }
    }
  })
