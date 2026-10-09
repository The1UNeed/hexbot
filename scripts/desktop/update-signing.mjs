// Release signatures for update manifests (docs/release.md, "Update signing").
// release.yml signs every manifest a client verifies with HEXBOT_UPDATE_SIGNING_KEY
// and checks each signature against packaging/update-signing-key.pub before
// upload. The daemon, the installer engine, and the Python handoff refuse a
// manifest without a valid signature; its checksums then pin every package.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PUBLIC_KEY = fileURLToPath(new URL('../../packaging/update-signing-key.pub', import.meta.url))
// DER prefixes that wrap a raw 32-byte Ed25519 key.
const SPKI = Buffer.from('302a300506032b6570032100', 'hex')
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex')

/** The trusted public keys, one per line (two while a key is replaced). */
export const releaseKeys = () => readFileSync(PUBLIC_KEY, 'utf8').split('\n').map(line => line.trim()).filter(Boolean)
const publicKey = base64 => createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(base64, 'base64')]), format: 'der', type: 'spki' })

/** The key debug builds trust, from a public seed. For tests and the fake update server only. */
export function testKey() {
  const seed = createHash('sha256').update('hexbot update signing test key').digest()
  return createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: 'der', type: 'pkcs8' })
}

export const testPublicKey = () => createPublicKey(testKey()).export({ type: 'spki', format: 'der' }).subarray(SPKI.length).toString('base64')

export const signature = (key, bytes) => sign(null, bytes, key).toString('base64')
export function verifies(keys, bytes, text) {
  return String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean).some(line => {
    // Do not let Node's permissive base64 decoder ignore trailing signatures.
    if (!/^[A-Za-z0-9+/]{86}==$/.test(line)) return false
    return [keys].flat().some(key => {
      try { return verify(null, bytes, publicKey(key), Buffer.from(line, 'base64')) }
      catch { return false }
    })
  })
}

/**
 * Signs the manifests clients verify:
 * daemon/native/<version>/<target>/manifest.json beside itself as manifest.json.sig, and
 * install/<channel>.json at the immutable install/<version>/<channel>.json.sig, so
 * replacing install/<channel>.json never races its signature.
 */
export function signUpdates(root, { channel, version, key, expected = releaseKeys() }) {
  const manifests = []
  const install = join(root, 'install', `${channel}.json`)
  if (!existsSync(install)) throw new Error(`Missing install/${channel}.json`)
  if (JSON.parse(readFileSync(install, 'utf8')).version !== version) throw new Error(`install/${channel}.json is not version ${version}`)
  manifests.push([install, join(root, 'install', version, `${channel}.json.sig`)])
  const native = join(root, 'daemon', 'native')
  for (const release of existsSync(native) ? readdirSync(native) : []) {
    for (const target of readdirSync(join(native, release))) {
      const manifest = join(native, release, target, 'manifest.json')
      if (existsSync(manifest)) manifests.push([manifest, `${manifest}.sig`])
    }
  }
  for (const [manifest, destination] of manifests) {
    const bytes = readFileSync(manifest)
    const signatures = [key].flat().map(key => signature(key, bytes))
    const text = signatures.join('\n')
    // A secret that does not match the committed public key fails here, before upload.
    if (!signatures.every(line => verifies(expected, bytes, line))) throw new Error('HEXBOT_UPDATE_SIGNING_KEY does not match packaging/update-signing-key.pub')
    mkdirSync(join(destination, '..'), { recursive: true })
    writeFileSync(destination, `${text}\n`)
  }
  return manifests.map(([, destination]) => destination)
}

/** A new release key: the private half to FILE (mode 0600), the public half added to packaging/. */
export function generate(file) {
  if (existsSync(file)) throw new Error(`${file} exists`)
  const pair = generateKeyPairSync('ed25519')
  writeFileSync(file, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const added = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(SPKI.length).toString('base64')
  writeFileSync(PUBLIC_KEY, `${[...existsSync(PUBLIC_KEY) ? releaseKeys() : [], added].join('\n')}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, path, ...rest] = process.argv.slice(2)
  const option = name => rest[rest.indexOf(name) + 1]
  if (command === 'sign' && path && rest.includes('--channel') && rest.includes('--version')) {
    const pem = process.env.HEXBOT_UPDATE_SIGNING_KEY
    if (!pem) throw new Error('HEXBOT_UPDATE_SIGNING_KEY is not set. See docs/release.md, "Update signing".')
    const keys = [pem, process.env.HEXBOT_UPDATE_SIGNING_KEY_NEXT].filter(Boolean).map(pem => createPrivateKey(pem))
    for (const file of signUpdates(resolve(path), { channel: option('--channel'), version: option('--version'), key: keys })) console.log(`Signed ${file}`)
  } else if (command === 'generate' && path) {
    generate(resolve(path))
    console.log(`Wrote ${resolve(path)} and added its public key to ${PUBLIC_KEY}. See docs/release.md, "Update signing".`)
  } else {
    throw new Error('Usage: node update-signing.mjs sign DIR --channel CHANNEL --version VERSION | generate FILE')
  }
}
