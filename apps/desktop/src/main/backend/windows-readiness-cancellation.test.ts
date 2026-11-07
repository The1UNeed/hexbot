// Portable tests for the optional read-only probe cancellation boundary.
// The child is Node, never a daemon or a Windows identity certification.
import type { ChildProcess, ExecFileOptions } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { windowsDaemon } from './windows-readiness'

const model = vi.hoisted(() => ({ code: '', child: undefined as ChildProcess | undefined,
  options: undefined as ExecFileOptions | undefined, started: () => {}, order: [] as string[] }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const execFile = Object.assign(() => { throw new Error('Expected promisified read-only probe') }, {
    [promisify.custom]: (_executable: string, _args: string[], options: ExecFileOptions) => {
      model.options = options
      const pending = promisify(actual.execFile)(process.execPath, ['-e', model.code], options)
      model.child = pending.child
      pending.child.stdout!.once('data', () => model.started())
      pending.child.once('close', () => model.order.push('closed'))
      return pending
    }
  })
  return { ...actual, execFile }
})
const roots: string[] = []
const originalSystem = process.env.SystemRoot
async function home() {
  const root = await mkdtemp(join(tmpdir(), 'hexbot probe cancellation '))
  roots.push(root)
  await writeFile(join(root, 'native-daemon.lock'), '')
  process.env.SystemRoot = root
  model.order = []
  model.child = undefined
  return root
}
afterEach(async () => {
  const child = model.child
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'close')
    child.kill('SIGKILL')
    await closed
  }
  if (originalSystem === undefined) delete process.env.SystemRoot
  else process.env.SystemRoot = originalSystem
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('optional abort kills and reaps the actual owned read-only child before returning', async () => {
  const root = await home(), controller = new AbortController()
  let notifyStarted!: () => void
  const started = new Promise<void>(resolve => { notifyStarted = resolve })
  model.started = notifyStarted
  model.code = "process.stdout.write('PROBE');process.stdin.resume()"
  const pending = windowsDaemon(root, controller.signal)
  const failure = new Error('remaining operation deadline')
  const rejected = expect(pending.catch(error => { model.order.push('rejected'); throw error })).rejects.toBe(failure)
  await started
  const pid = model.child!.pid!
  expect(model.options?.timeout).toBe(10_000)
  expect(model.options?.signal).toBe(controller.signal)
  controller.abort(failure)
  await rejected
  expect(model.order).toEqual(['closed', 'rejected'])
  expect(() => process.kill(pid, 0)).toThrow()
})

it('pre-abort starts no child, and default callers retain their existing cap and sanitized failure', async () => {
  const root = await home(), controller = new AbortController()
  controller.abort(new Error('already expired'))
  await expect(windowsDaemon(root, controller.signal)).rejects.toThrow('already expired')
  expect(model.child).toBeUndefined()
  model.code = "process.stderr.write('private fixture detail');process.exit(1)"
  await expect(windowsDaemon(root)).rejects.toThrow(/^Cannot verify the daemon holding this home$/)
  expect(model.options?.timeout).toBe(10_000)
  expect(model.options).not.toHaveProperty('signal')
})

it('optional success still performs managed executable and actual image validation', async () => {
  const root = await home()
  const directory = join(root, 'runtime/native/selected')
  await mkdir(directory, { recursive: true })
  const executable = join(directory, 'hexbot.exe')
  await writeFile(executable, '')
  const value = { pid: 42, port: 9119, executable, image: executable, created: 'fixture-created' }
  model.code = `console.log(${JSON.stringify(JSON.stringify(value))})`
  const controller = new AbortController()
  await expect(windowsDaemon(root, controller.signal)).resolves.toMatchObject({ pid: 42, port: 9119 })
  const image = join(root, 'another.exe')
  await writeFile(image, '')
  model.code = `console.log(${JSON.stringify(JSON.stringify({ ...value, image }))})`
  await expect(windowsDaemon(root, controller.signal)).rejects.toThrow('outside this managed runtime')
})
