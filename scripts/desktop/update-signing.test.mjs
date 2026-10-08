import assert from 'node:assert/strict'
import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { releaseKeys, signUpdates, testKey, testPublicKey, verifies } from './update-signing.mjs'

const raw = key => createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')

function feed(t) {
  const root = mkdtempSync(join(tmpdir(), 'hexbot-signing-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'install'), { recursive: true })
  mkdirSync(join(root, 'daemon/native/1.2.3/linux-x86_64'), { recursive: true })
  writeFileSync(join(root, 'install/nightly.json'), '{"version":"1.2.3","channel":"nightly"}\n')
  writeFileSync(join(root, 'daemon/native/1.2.3/linux-x86_64/manifest.json'), '{"version":"1.2.3"}\n')
  return root
}

test('every manifest a client verifies is signed, the install manifest at its immutable version path', t => {
  const root = feed(t)
  const key = testKey()
  const written = signUpdates(root, { channel: 'nightly', version: '1.2.3', key, expected: raw(key) })
  assert.deepEqual(written, [join(root, 'install/1.2.3/nightly.json.sig'), join(root, 'daemon/native/1.2.3/linux-x86_64/manifest.json.sig')])
  for (const [manifest, signature] of [['install/nightly.json', 'install/1.2.3/nightly.json.sig'], ['daemon/native/1.2.3/linux-x86_64/manifest.json', 'daemon/native/1.2.3/linux-x86_64/manifest.json.sig']]) {
    const bytes = readFileSync(join(root, manifest))
    const text = readFileSync(join(root, signature), 'utf8')
    assert.ok(verifies(raw(key), bytes, text))
    assert.ok(!verifies(raw(key), Buffer.concat([bytes, Buffer.from(' ')]), text))
  }
})

test('a signing secret that does not match the committed public key fails before anything is written', t => {
  const root = feed(t)
  assert.throws(() => signUpdates(root, { channel: 'nightly', version: '1.2.3', key: generateKeyPairSync('ed25519').privateKey }), /does not match/)
  assert.ok(!existsSync(join(root, 'install/1.2.3')))
  assert.throws(() => signUpdates(root, { channel: 'nightly', version: '1.2.4', key: testKey() }), /not version 1.2.4/)
})

test('the release key is a raw Ed25519 key and the Rust verifier trusts the same test key', () => {
  for (const key of releaseKeys()) assert.equal(Buffer.from(key, 'base64').length, 32)
  const rust = readFileSync(new URL('../../backend/hexbot-core/src/update_signature.rs', import.meta.url), 'utf8')
  assert.equal(rust.match(/pub const TEST_KEY: &str = "([^"]+)"/)[1], testPublicKey())
  const python = readFileSync(new URL('../../backend/python-handoff/hexbot/update_signature.py', import.meta.url), 'utf8')
  assert.deepEqual([...python.match(/RELEASE_KEYS = \(([^)]*)\)/)[1].matchAll(/"([^"]+)"/g)].map(match => match[1]), releaseKeys())
})
