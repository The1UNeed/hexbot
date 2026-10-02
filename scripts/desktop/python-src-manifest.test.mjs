import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { handoffFiles, stagePythonSource } from './python-src-manifest.mjs'

test('service source contains only the handoff package and a validated transition marker', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-source-stage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = join(root, 'repo')
  const destination = join(root, 'staged')
  for (const file of [...handoffFiles, 'tests/test_cli.py', 'hexbot/__pycache__/cli.pyc']) {
    const source = join(repository, 'backend/python-handoff', file)
    await mkdir(dirname(source), { recursive: true })
    await writeFile(source, file)
  }
  for (const file of ['apps/web/dist/index.html', 'agent/legacy.py', '.env']) {
    const source = join(repository, file)
    await mkdir(dirname(source), { recursive: true })
    await writeFile(source, 'must not ship')
  }
  await mkdir(destination)
  await writeFile(join(destination, 'stale.py'), 'old archive')
  await stagePythonSource(repository, destination, { nativeTransitionVersion: '1.2.3-nightly.20261002.1' })
  assert.deepEqual((await readdir(destination)).sort(), ['HEXBOT_NATIVE_TRANSITION.json', 'hexbot', 'pyproject.toml', 'uv.lock'])
  assert.deepEqual((await readdir(join(destination, 'hexbot'))).sort(), ['__init__.py', 'cli.py', 'native_transition.py'])
  assert.deepEqual(JSON.parse(await readFile(join(destination, 'HEXBOT_NATIVE_TRANSITION.json'))), { version: '1.2.3-nightly.20261002.1' })
  for (const file of handoffFiles) assert.equal(await readFile(join(destination, file), 'utf8'), file)
  for (const version of [undefined, '../invalid', '1.2.3\n', 123]) {
    await assert.rejects(stagePythonSource(repository, destination, { nativeTransitionVersion: version }), /Invalid native transition/)
  }
  await access(join(destination, 'pyproject.toml')) // invalid input never removes an existing archive
})
