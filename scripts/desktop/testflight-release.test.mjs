import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)
const release = await readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
const job = release.match(/^  testflight:\n([\s\S]*?)(?=^  \w+:)/m)?.[1]

test('only nightlies that passed release checks can start TestFlight', () => {
  assert.ok(job)
  assert.match(job, /needs: \[preflight, check\]/)
  const condition = job.match(/^    if: (.+)$/m)?.[1]
  assert.ok(condition)
  const enabled = new Function('needs', `return (${condition})`)
  for (const [channel, build, expected] of [
    ['nightly', 'true', true],
    ['nightly', 'false', false],
    ['stable', 'true', false],
    ['stable', 'false', false],
    ['', 'true', false]
  ]) {
    assert.equal(enabled({ preflight: { outputs: { channel, build } } }), expected, `${channel}, build=${build}`)
  }
})

test('missing Expo credentials fail preflight only for a nightly being built', async () => {
  const step = release.match(/- name: Validate the Expo access token\n([\s\S]*?)(?=^  \w+:)/m)?.[1]
  assert.ok(step)
  const condition = step.match(/if: (.+)/)?.[1]
  const enabled = new Function('steps', `return (${condition})`)
  for (const [channel, build, expected] of [['nightly', 'true', true], ['stable', 'true', false], ['nightly', 'false', false]]) {
    assert.equal(enabled({ resolve: { outputs: { channel, build } } }), expected)
  }
  const script = step.split('        run: |\n')[1].replace(/^          /gm, '')
  await assert.rejects(run('bash', ['-c', script], { env: { ...process.env, EXPO_TOKEN: '' } }), /EXPO_TOKEN repository secret/)
  await run('bash', ['-c', script], { env: { ...process.env, EXPO_TOKEN: 'fixture-token' } })
})

test('TestFlight builds the exact release commit rather than a moving main branch', async t => {
  assert.ok(job)
  assert.match(job, /EXPO_TOKEN: \$\{\{ secrets\.EXPO_TOKEN \}\}/)
  const command = job.match(/run: (pnpm mobile:testflight .+)/)?.[1]
  assert.ok(command)
  const root = await mkdtemp(join(tmpdir(), 'hexbot-testflight-release-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'bin'))
  await writeFile(join(root, 'bin/pnpm'), `#!${process.execPath}\nrequire('node:fs').writeFileSync('arguments.json', JSON.stringify(process.argv.slice(2)))\n`, { mode: 0o755 })
  const sha = '1234567890abcdef1234567890abcdef12345678'
  await run('bash', ['-c', command], { cwd: root, env: { ...process.env, GITHUB_SHA: sha, PATH: `${join(root, 'bin')}:${process.env.PATH}` } })
  assert.deepEqual(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8')), ['mobile:testflight', '--ref', sha])
})

test('Expo does not also build on every push to main', async () => {
  const workflow = await readFile(new URL('../../apps/mobile/.eas/workflows/testflight.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(workflow, /^\s+push:/m)
  assert.match(workflow, /workflow_dispatch: \{\}/)
})
