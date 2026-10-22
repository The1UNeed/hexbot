import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  compareEntitlements,
  explain,
  explainMissing,
  profileEntitlements,
  readRecord
} from './ios-entitlements.mjs'

test('matching lists report no change', () => {
  assert.deepEqual(compareEntitlements(['aps-environment'], ['aps-environment']), {
    added: [],
    removed: []
  })
})

test('a new entitlement is reported as added, a dropped one as removed', () => {
  const diff = compareEntitlements(['aps-environment'], ['com.apple.developer.associated-domains'])
  assert.deepEqual(diff, {
    added: ['com.apple.developer.associated-domains'],
    removed: ['aps-environment']
  })
  const message = explain(diff)
  assert.match(message, /added com\.apple\.developer\.associated-domains; removed aps-environment/)
  assert.match(message, /Regenerate the profile first/)
  assert.match(message, /entitlements --write/)
})

test('the record lists each entitlement once, sorted', async () => {
  const { entitlements } = await readRecord()
  assert.deepEqual(entitlements, [...new Set(entitlements)].sort())
})

test('profile entitlements are the top-level keys of the Entitlements dictionary', () => {
  const plist = `<?xml version="1.0"?><plist version="1.0"><dict>
    <key>AppIDName</key><string>Hexbot</string>
    <key>Entitlements</key>
    <dict>
      <key>beta-reports-active</key><true/>
      <key>aps-environment</key><string>production</string>
      <key>keychain-access-groups</key>
      <array><string>TEAM.*</string><dict><key>nested</key><string>x</string></dict></array>
      <key>com.apple.developer.team-identifier</key><string>TEAM</string>
    </dict>
    <key>Name</key><string>profile</string>
    <key>TeamIdentifier</key><array><string>TEAM</string></array>
  </dict></plist>`
  const signed = Buffer.concat([
    Buffer.from([0x30, 0x82, 0x00]),
    Buffer.from(plist),
    Buffer.from([0x00, 0xff])
  ])
  assert.deepEqual(profileEntitlements(signed.toString('base64')), [
    'aps-environment',
    'beta-reports-active',
    'com.apple.developer.team-identifier',
    'keychain-access-groups'
  ])
  assert.match(explainMissing('ABC123', ['aps-environment']), /\(ABC123\) lacks: aps-environment/)
  assert.throws(
    () => profileEntitlements(Buffer.from('<plist></plist>').toString('base64')),
    /no Entitlements/
  )
})

test('the App Store Connect token is an ES256 JWT signed by the key', async () => {
  const { generateKeyPairSync, verify } = await import('node:crypto')
  const { ascToken, expectProgram } = await import('./ios-profile.mjs')
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const keyP8 = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const token = ascToken({ keyId: 'KEY1', issuerId: 'issuer', keyP8 }, 1_700_000_000)
  const [header, payload, signature] = token.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), {
    alg: 'ES256',
    kid: 'KEY1',
    typ: 'JWT'
  })
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), {
    iss: 'issuer',
    iat: 1_700_000_000,
    exp: 1_700_001_200,
    aud: 'appstoreconnect-v1'
  })
  assert.ok(
    verify(
      'sha256',
      Buffer.from(`${header}.${payload}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url')
    )
  )
  const program = expectProgram('/tmp/mobile')
  assert.match(
    program,
    /spawn pnpm exec eas credentials:configure-build --platform ios --profile production/
  )
  assert.match(program, /\(Y\/n\\\)\} \{ send "y\\r"/)
})
