import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { prepareRoot } from './dev-fake-root.mjs'

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hexbot-fake-test-'))

  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  return directory
}

test('claims new and empty roots, and keeps installed files on reuse', t => {
  const directory = fixture(t)

  for (const root of [directory, path.join(directory, 'new')]) {
    assert.equal(prepareRoot(root, os.homedir()), root)
    assert.ok(fs.statSync(path.join(root, '.hexbot-dev-fake')).isFile())
    fs.mkdirSync(path.join(root, 'home'))
    fs.writeFileSync(path.join(root, 'home', 'keep'), 'installed')
    prepareRoot(root, os.homedir())
    assert.equal(fs.readFileSync(path.join(root, 'home', 'keep'), 'utf8'), 'installed')
  }
})

test('the CLI refuses an unmarked nonempty root before deleting build or server files', t => {
  const root = fixture(t)

  for (const name of ['build', 'server']) {
    fs.mkdirSync(path.join(root, name))
    fs.writeFileSync(path.join(root, name, 'keep'), 'user data')
  }

  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./dev-fake.mjs', import.meta.url)), '--root', root, '--server-only'
  ], { encoding: 'utf8', timeout: 5000 })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /directory is not empty and has no \.hexbot-dev-fake marker/)
  for (const name of ['build', 'server']) {
    assert.equal(fs.readFileSync(path.join(root, name, 'keep'), 'utf8'), 'user data')
  }
  assert.equal(fs.existsSync(path.join(root, '.hexbot-dev-fake')), false)
})

test('a directory or symlink cannot stand in for the marker', t => {
  const root = fixture(t)
  const marker = path.join(root, '.hexbot-dev-fake')

  fs.mkdirSync(marker)
  assert.throws(() => prepareRoot(root, os.homedir()), /no .hexbot-dev-fake marker/)
  fs.rmdirSync(marker)
  fs.writeFileSync(path.join(root, 'file'), '')
  fs.symlinkSync(path.join(root, 'file'), marker)
  assert.throws(() => prepareRoot(root, os.homedir()), /no .hexbot-dev-fake marker/)
})

test('a marked root cannot bypass protected paths, including through a symlink', t => {
  const directory = fixture(t)
  const home = path.join(directory, 'home')
  const state = path.join(home, '.hexbot')

  fs.mkdirSync(state, { recursive: true })
  fs.writeFileSync(path.join(state, '.hexbot-dev-fake'), '')
  const link = path.join(directory, 'link')

  fs.symlinkSync(state, link)
  for (const root of [home, state, link, path.join(link, 'new')]) {
    assert.throws(() => prepareRoot(root, home), /overlaps your real home/)
  }
})
