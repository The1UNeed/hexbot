import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { stagePythonSource } from './python-src-manifest.mjs'

test('source updates mark Rust transitions while explicit Python builds stay Python', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-source-stage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = join(root, 'repo')
  const destination = join(root, 'staged')
  for (const directory of ['hexbot', 'backend/target', '.hexbot', 'apps/web/dist']) {
    await mkdir(join(repository, directory), { recursive: true })
  }
  await writeFile(join(repository, 'hexbot/native_transition.py'), '# transition shim\n')
  await writeFile(join(repository, 'pyproject.toml'), '[project]\n')
  await writeFile(join(repository, 'apps/web/dist/index.html'), 'unchanged UI')
  await writeFile(join(repository, 'HEXBOT_NATIVE_TRANSITION.json'), '{"version":"stale"}')
  await writeFile(join(repository, '.env'), 'secret')
  await stagePythonSource(repository, destination, { nativeTransitionVersion: '1.2.3' })
  assert.deepEqual(JSON.parse(await readFile(join(destination, 'HEXBOT_NATIVE_TRANSITION.json'))), { version: '1.2.3' })
  assert.equal(await readFile(join(destination, 'apps/web/dist/index.html'), 'utf8'), 'unchanged UI')
  await access(join(destination, 'hexbot/native_transition.py'))
  for (const excluded of ['backend', '.hexbot', '.env']) {
    await assert.rejects(access(join(destination, excluded)), { code: 'ENOENT' })
  }
  await stagePythonSource(repository, destination)
  await assert.rejects(access(join(destination, 'HEXBOT_NATIVE_TRANSITION.json')), { code: 'ENOENT' })
  await assert.rejects(stagePythonSource(repository, destination, { nativeTransitionVersion: '../invalid' }), /Invalid native transition/)
})
