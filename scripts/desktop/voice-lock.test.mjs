import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { windowsWheel, supportedWheels, renderLock, verifyLock } from './voice-lock.mjs'

test('voice lock generation requires the correct Windows ABI and authoritative digest', () => {
  const file = filename => ({ filename, url: 'https://files.pythonhosted.org/packages/wheel.whl', digests: { sha256: 'a'.repeat(64) }, yanked: false })
  const pure = file('fixture-1.0-py3-none-any.whl')
  const native = file('fixture-1.0-cp311-cp311-win_amd64.whl')
  assert.equal(windowsWheel([pure, native]), native)
  assert.equal(windowsWheel([pure]), pure)
  assert.throws(() => windowsWheel([file('fixture-1.0-cp312-cp312-win_amd64.whl')]))
  assert.throws(() => windowsWheel([{ ...native, yanked: true }]))
  assert.throws(() => windowsWheel([{ ...native, url: 'https://example.invalid/wheel.whl' }]))
  const pins = 'fixture==1.0\n'
  const record = { name: 'fixture', version: '1.0', sha256: 'a'.repeat(64), hashes: ['a'.repeat(64), 'b'.repeat(64)] }
  const updated = renderLock(pins, [record])
  assert(updated.includes('b'.repeat(64)) && updated.includes('a'.repeat(64)))
  assert.throws(() => renderLock(pins, [{ ...record, version: '2.0' }]))
  assert.equal(supportedWheels([pure, native, file('fixture-1.0-cp311-cp311-macosx_11_0_arm64.whl'), file('fixture-1.0-cp311-cp311-win32.whl')]).length, 3)
})

test('every locked Windows dependency has a compatible audited wheel hash', async () => {
  const path = new URL('../../backend/hexbot-core/assets/', import.meta.url)
  const text = await readFile(new URL('edge-tts.requirements.txt', path), 'utf8')
  const audit = JSON.parse(await readFile(new URL('edge-tts.windows-wheels.json', path), 'utf8'))
  assert.equal(audit.python, '3.11'); assert.equal(audit.platform, 'win_amd64')
  const pins = await readFile(new URL('edge-tts.requirements.in', path), 'utf8')
  verifyLock(pins, audit.wheels, text)
  for (const record of audit.wheels) {
    assert.match(record.filename, /-(?:cp311-cp311-win_amd64|py(?:2\.)?3-none-any)\.whl$/)
    assert.equal(record.metadata, `https://pypi.org/pypi/${record.name}/${record.version}/json`)
  }
  // Reproduce the old platform-limited lock and require regeneration to fix it.
  const native = audit.wheels.find(wheel => wheel.name === 'aiohttp')
  const normalized = text.replaceAll('\r\n', '\n')
  const damaged = normalized.replace(` \\\n    --hash=sha256:${native.sha256}`, '')
  assert.notEqual(damaged, normalized, 'The adverse fixture must remove the Windows wheel hash')
  assert.throws(() => verifyLock(pins, audit.wheels, damaged))
})


test('voice lock keeps legacy manylinux multi-tags for existing Unix targets', () => {
  const names = [
    'fixture-1-cp311-cp311-manylinux2014_aarch64.manylinux_2_17_aarch64.manylinux_2_28_aarch64.whl',
    'fixture-1-cp311-cp311-manylinux1_x86_64.manylinux2014_x86_64.manylinux_2_17_x86_64.whl',
    'fixture-1-cp311-cp311-manylinux_2_28_x86_64.whl',
    'fixture-1-cp311-cp311-musllinux_1_2_aarch64.whl',
  ]
  assert.equal(supportedWheels(names.map(filename => ({ filename }))).length, names.length)
})


test('voice lock accepts LF and checkout CRLF without accepting altered pins or hashes', () => {
  const pins = 'fixture==1.0\n'
  const record = { name: 'fixture', version: '1.0', sha256: 'a'.repeat(64), hashes: ['a'.repeat(64), 'b'.repeat(64)] }
  const lock = renderLock(pins, [record])
  for (const ending of ['\n', '\r\n']) {
    const input = pins.replaceAll('\n', ending)
    const checked = lock.replaceAll('\n', ending)
    verifyLock(input, [record], checked)
    assert.equal(renderLock(input, [record]), lock)
    assert.throws(() => verifyLock(input, [record], checked.replace('b'.repeat(64), 'c'.repeat(64))))
    assert.throws(() => verifyLock(input, [record], checked.replace('fixture==1.0', 'fixture==2.0')))
    assert.throws(() => verifyLock(input, [record], checked.replace(` \\${ending}    --hash=sha256:${'b'.repeat(64)}`, '')))
  }
  assert.throws(() => verifyLock(pins, [record], lock.replaceAll('\n', '\r')))
})
