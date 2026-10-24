import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { windowsPnpmCommand } from './pnpm-command.mjs'

test('rejects empty or relative discovery results', () => {
  assert.throws(() => windowsPnpmCommand([]), /Cannot locate/)
  assert.throws(() => windowsPnpmCommand(['pnpm.cmd']), /Cannot locate/)
})

for (const layout of ['../pnpm/bin/pnpm.cjs', 'node_modules/pnpm/bin/pnpm.cjs', 'node_modules/corepack/dist/pnpm.js', 'pnpm.exe']) {
  test(`resolves the explicit ${layout} layout without reading a command shim`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'hexbot-pnpm-π '))
    t.after(() => rm(root, { recursive: true, force: true }))
    const shim = join(root, 'bin', 'pnpm.cmd')
    const entry = resolve(dirname(shim), layout)
    await mkdir(dirname(entry), { recursive: true })
    await mkdir(dirname(shim), { recursive: true })
    await writeFile(shim, 'This must never be parsed or executed & exit 99')
    await mkdir(entry)
    assert.throws(() => windowsPnpmCommand([shim, entry]), /Cannot locate/)
    await rm(entry, { recursive: true })
    await writeFile(entry, '')
    assert.deepEqual(windowsPnpmCommand([shim, ...(layout.endsWith('.exe') ? [entry] : [])]), layout.endsWith('.exe')
      ? { command: entry, prefix: [] } : { command: process.execPath, prefix: [entry] })
  })
}

test('real Corepack launches the project-pinned pnpm with literal argv', { skip: !process.env.HEXBOT_TEST_COREPACK_ROOT && process.platform !== 'win32' }, async t => {
  assert(process.env.HEXBOT_TEST_COREPACK_ROOT, 'Windows CI must provision isolated real Corepack')
  const root = resolve(process.env.HEXBOT_TEST_COREPACK_ROOT)
  const run = promisify(execFile)
  const exec = (command, args) => run(command, args, { env: { ...process.env, COREPACK_HOME: join(root, 'cache'), COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' } })
  await exec(process.execPath, [join(root, 'node_modules/corepack/dist/corepack.js'), 'enable', '--install-directory', root, 'pnpm'])
  assert((await stat(join(root, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'))).isFile())
  const shim = join(root, 'pnpm.cmd')
  const command = windowsPnpmCommand([shim])
  assert.equal(command.prefix[0], join(root, 'node_modules/corepack/dist/pnpm.js'))
  const { stdout } = await exec(command.command, [...command.prefix, '--version'])
  assert.equal(stdout.trim(), '10.29.3')
  const temp = await mkdtemp(join(tmpdir(), 'hexbot-corepack-argv-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const script = join(temp, 'argv π & check.mjs')
  await writeFile(script, 'console.log(JSON.stringify(process.argv.slice(2)))')
  const args = ['two words', 'π 中文 é 🦊', 'a"b', 'a&b']
  const result = await exec(command.command, [...command.prefix, 'exec', process.execPath, script, ...args])
  assert.deepEqual(JSON.parse(result.stdout), args)
})
