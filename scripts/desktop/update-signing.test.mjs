import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import test from 'node:test'
import { releaseKeys, signUpdates, signingKeys, testKey, testPublicKey, verifies } from './update-signing.mjs'

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

test('two signature lines support clients trusting either rotation key', t => {
  const root = feed(t)
  const old = testKey()
  const next = generateKeyPairSync('ed25519').privateKey
  const keys = [raw(old), raw(next)]
  const written = signUpdates(root, { channel: 'nightly', version: '1.2.3', key: [old, next], expected: keys })
  for (const file of written) {
    const bytes = readFileSync(relative(root, file).split(sep)[0] === 'install' ? join(root, 'install/nightly.json') : file.slice(0, -4))
    const text = readFileSync(file, 'utf8')
    assert.equal(text.trim().split('\n').length, 2)
    for (const key of keys) assert.ok(verifies(key, bytes, text))
    assert.ok(verifies(keys[1], bytes, `\n${text}\n`))
    assert.ok(!verifies(raw(generateKeyPairSync('ed25519').privateKey), bytes, text))
    assert.ok(!verifies(keys, Buffer.concat([bytes, Buffer.from(' ')]), text))
    assert.ok(!verifies(keys, bytes, text.replaceAll('\n', '')))
  }
  assert.throws(() => signUpdates(root, { channel: 'nightly', version: '1.2.3', key: [old, next], expected: raw(old) }), /does not match/)
})

test('preflight validates PEMs and identifies the mismatched rotation secret', () => {
  const old = testKey()
  const next = generateKeyPairSync('ed25519').privateKey
  const pem = key => key.export({ type: 'pkcs8', format: 'pem' })
  const environment = { HEXBOT_UPDATE_SIGNING_KEY: pem(old), HEXBOT_UPDATE_SIGNING_KEY_NEXT: pem(next) }
  assert.equal(signingKeys(environment, [raw(old), raw(next)]).length, 2)
  assert.throws(() => signingKeys({}, raw(old)), /HEXBOT_UPDATE_SIGNING_KEY is not set/)
  assert.throws(() => signingKeys({ HEXBOT_UPDATE_SIGNING_KEY: 'test' }, raw(old)), /HEXBOT_UPDATE_SIGNING_KEY is not a valid/)
  assert.throws(() => signingKeys(environment, raw(old)), /HEXBOT_UPDATE_SIGNING_KEY_NEXT does not match/)
  assert.throws(() => signingKeys({ HEXBOT_UPDATE_SIGNING_KEY: pem(next) }, raw(old)), /HEXBOT_UPDATE_SIGNING_KEY does not match/)
  const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey
  assert.throws(() => signingKeys({ HEXBOT_UPDATE_SIGNING_KEY: pem(rsa) }, raw(old)), /must be an Ed25519/)
})

test('release preflight validates signing keys only after resolving a build', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
  const preflight = workflow.split('  check:')[0]
  const step = preflight.slice(preflight.indexOf('      - name: Validate the update signing keys'))
  assert.ok(preflight.indexOf('      - id: resolve') < preflight.indexOf(step))
  assert.match(step, /if: steps\.resolve\.outputs\.build == 'true'/)
  assert.match(step, /HEXBOT_UPDATE_SIGNING_KEY_NEXT: \$\{\{ secrets\.HEXBOT_UPDATE_SIGNING_KEY_NEXT \}\}/)
  assert.match(workflow, /needs: preflight\n    if: needs\.preflight\.outputs\.build == 'true'/)
  const script = step.match(/run: (.+)/)[1]
  for (const [key, message] of [['', 'is not set'], ['test', 'is not a valid'], [testKey().export({ type: 'pkcs8', format: 'pem' }), 'does not match']]) {
    const result = spawnSync('bash', ['-c', script], { env: { ...process.env, HEXBOT_UPDATE_SIGNING_KEY: key, HEXBOT_UPDATE_SIGNING_KEY_NEXT: '' }, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.ok(result.stderr.includes(`HEXBOT_UPDATE_SIGNING_KEY ${message}`), result.stderr)
  }
})
