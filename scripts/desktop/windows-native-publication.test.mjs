import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { NODE_VERSION, publishNativeRuntime, standaloneNode } from './native-runtime.mjs'

test('pinned Windows Node/Pi version-process exit permits verified directory publication',
  { skip: process.platform !== 'win32', timeout: 180_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'hexbot real publication π '))
    try {
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
    } finally { await rm(root, { recursive: true, force: true }) }
  })
