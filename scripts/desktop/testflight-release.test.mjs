import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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

test('TestFlight builds the release checkout on the runner and uploads that build', async t => {
  // Expo's free plan allows 15 iOS cloud builds a month, fewer than one a
  // night, so the nightly builds locally and Expo only uploads it.
  assert.ok(job)
  assert.match(job, /^    runs-on: macos-/m)
  assert.match(job, /EXPO_TOKEN: \$\{\{ secrets\.EXPO_TOKEN \}\}/)
  assert.doesNotMatch(job, /workflow:run|mobile:testflight|^\s+ref:/m)
  const build = job.match(/- name: Build iOS on this runner\n([\s\S]*?)(?=\n      - |$)/)?.[1]
  const upload = job.match(/- name: Upload to App Store Connect\n([\s\S]*?)(?=\n      - |$)/)?.[1]
  assert.ok(build && upload)
  for (const step of [build, upload]) assert.match(step, /working-directory: apps\/mobile/)
  const script = build.split('        run: |\n')[1].replace(/^          /gm, '')
  const submit = upload.match(/run: (.+)/)?.[1]
  assert.ok(script && submit)

  const root = await mkdtemp(join(tmpdir(), 'hexbot-testflight-release-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'bin'))
  const record = `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(join(root, 'calls'))}, JSON.stringify([require('node:path').basename(process.argv[1]), ...process.argv.slice(2)]) + '\\n')\n`
  for (const tool of ['pnpm', 'brew', 'fastlane', 'pod']) await writeFile(join(root, 'bin', tool), record, { mode: 0o755 })
  const env = { ...process.env, RUNNER_TEMP: '/runner/temp', PATH: `${join(root, 'bin')}:/usr/bin:/bin` }
  await run('bash', ['-e', '-c', script], { cwd: root, env })
  await run('bash', ['-e', '-c', submit], { cwd: root, env })
  const calls = (await readFile(join(root, 'calls'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(calls, [
    ['pnpm', 'exec', 'eas', 'build', '--platform', 'ios', '--profile', 'production', '--local', '--non-interactive', '--output', '/runner/temp/Hexbot.ipa'],
    ['pnpm', 'exec', 'eas', 'submit', '--platform', 'ios', '--profile', 'production', '--path', '/runner/temp/Hexbot.ipa', '--non-interactive']
  ])
})

test('the iOS build installs fastlane and CocoaPods only when the runner lacks them', async t => {
  // eas build --local needs both; GitHub's macOS images usually carry them.
  const build = job?.match(/- name: Build iOS on this runner\n([\s\S]*?)(?=\n      - |$)/)?.[1]
  const install = build?.split('        run: |\n')[1].split('\n').filter(line => line.includes('brew install')).join('\n')
  assert.ok(install)
  const root = await mkdtemp(join(tmpdir(), 'hexbot-testflight-tools-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'bin'))
  await writeFile(join(root, 'bin/brew'), `#!/bin/sh\necho "$@" >> ${join(root, 'brew')}\n`, { mode: 0o755 })
  const env = { ...process.env, PATH: `${join(root, 'bin')}:/usr/bin:/bin` }
  const installed = async () => (await readFile(join(root, 'brew'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
  await run('bash', ['-e', '-c', install], { env })
  assert.deepEqual(await installed(), ['install fastlane', 'install cocoapods'])
  await rm(join(root, 'brew'))
  await writeFile(join(root, 'bin/fastlane'), '#!/bin/sh\n', { mode: 0o755 })
  await run('bash', ['-e', '-c', install], { env })
  assert.deepEqual(await installed(), ['install cocoapods'])
  await rm(join(root, 'brew'))
  await writeFile(join(root, 'bin/pod'), '#!/bin/sh\n', { mode: 0o755 })
  await run('bash', ['-e', '-c', install], { env })
  assert.deepEqual(await installed(), [])
})

test('Expo does not also build on every push to main', async () => {
  const workflow = await readFile(new URL('../../apps/mobile/.eas/workflows/testflight.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(workflow, /^\s+push:/m)
  assert.match(workflow, /workflow_dispatch: \{\}/)
})

const easWorkflow = name => readFile(new URL(`../../apps/mobile/.eas/workflows/${name}`, import.meta.url), 'utf8')

test('uploads use only jobs the free Expo plan runs', async () => {
  // Expo starts a testflight job with build_id only on paid plans; it fails
  // before running on the free plan the project uses. Upload with submit.
  for (const name of ['testflight.yml', 'testflight-upload.yml']) {
    const workflow = await easWorkflow(name)
    assert.match(workflow, /^    type: submit$/m, name)
    assert.match(workflow, /^      build_id: \$\{\{ .+ \}\}$/m, name)
    assert.match(workflow, /^      profile: production$/m, name)
  }
  for (const name of await readdir(new URL('../../apps/mobile/.eas/workflows/', import.meta.url))) {
    const jobs = (await easWorkflow(name)).split(/^  (?=\w+:\n)/m).slice(1)
    for (const job of jobs.filter(job => /^    type: testflight$/m.test(job))) {
      assert.doesNotMatch(job, /^      build_id:/m, `${name}: a testflight job needs asc_build_id`)
    }
  }
})

test('every build Apple processes reaches the public link group', async () => {
  const workflow = await easWorkflow('testflight-testers.yml')
  assert.match(workflow, /^on:\n  app_store_connect:\n    build_upload:\n      states: \[complete\]$/m)
  assert.match(workflow, /^    type: testflight$/m)
  assert.match(workflow, /^      asc_build_id: \$\{\{ app_store_connect\.build_upload\.build\.id \}\}$/m)
  assert.match(workflow, /^      external_groups: \[Website0\]$/m)
})
