// Regenerates the production provisioning profile stored on EAS without an
// Apple sign-in. README.md, "iOS capabilities and the provisioning profile".
//
// `eas credentials:configure-build` does this only partly on its own. With an
// Apple ID it wants the password and a two-factor code whenever the saved
// session has expired. With the App Store Connect API key that EAS already
// holds for submissions, eas-cli 24 cannot enable a new capability on the App
// ID (Apple's public API rejects its bulk update) and still asks yes/no
// questions on a terminal. So this script enables the missing capabilities
// through the App Store Connect API itself, then runs eas-cli with that key
// in a pseudo-terminal and answers yes to its confirmations.
//
// Needs EXPO_TOKEN or an `eas login` session that can read the project's
// credentials. The key is written to a private temp file for the eas-cli run
// and removed afterwards. Run with --check to only report what would change.
import { spawn } from 'node:child_process'
import { createPrivateKey, sign } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { easQuery, fetchStoredProfile, resolveConfig } from './ios-entitlements.mjs'

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ascApi = 'https://api.appstoreconnect.apple.com/v1'

// eas-cli's own table of entitlement key to Apple capability type.
export function capabilityFor(entitlement) {
  const { CapabilityMapping } = createRequire(import.meta.url)(
    'eas-cli/build/credentials/ios/appstore/capabilityList.js'
  )
  return CapabilityMapping.find(entry => entry.entitlement === entitlement)?.capability ?? null
}

// The team App Store Connect API key EAS stores for submissions of this app.
export async function fetchSubmissionKey({ projectId, bundleIdentifier }) {
  const data = await easQuery(
    `query($appId: String!) { app { byId(appId: $appId) { iosAppCredentials(filter: { appleAppIdentifierId: null }) {
      appleAppIdentifier { bundleIdentifier }
      appStoreConnectApiKeyForSubmissions { id appleTeam { appleTeamIdentifier appleTeamType } }
    } } } }`,
    { appId: projectId }
  )
  const credentials = data.app.byId.iosAppCredentials.find(
    entry => entry.appleAppIdentifier.bundleIdentifier === bundleIdentifier
  )
  const summary = credentials?.appStoreConnectApiKeyForSubmissions
  if (!summary)
    throw new Error(
      `EAS holds no App Store Connect API key for ${bundleIdentifier}; add one with \`eas credentials\``
    )
  const { appStoreConnectApiKey } = await easQuery(
    `query($id: ID!) { appStoreConnectApiKey { byId(id: $id) { keyIdentifier issuerIdentifier keyP8 } } }`,
    { id: summary.id }
  )
  const key = appStoreConnectApiKey.byId
  if (!key.issuerIdentifier)
    throw new Error(
      'The stored App Store Connect API key is an individual key; a team key is needed'
    )
  return {
    keyId: key.keyIdentifier,
    issuerId: key.issuerIdentifier,
    keyP8: key.keyP8,
    teamId: summary.appleTeam?.appleTeamIdentifier,
    teamType: summary.appleTeam?.appleTeamType
  }
}

export function ascToken({ keyId, issuerId, keyP8 }, now = Math.floor(Date.now() / 1000)) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const body = `${encode({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${encode({ iss: issuerId, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' })}`
  const signature = sign('sha256', Buffer.from(body), {
    key: createPrivateKey(keyP8),
    dsaEncoding: 'ieee-p1363'
  })
  return `${body}.${signature.toString('base64url')}`
}

async function asc(token, method, route, body) {
  const response = await fetch(`${ascApi}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body && JSON.stringify(body)
  })
  if (response.status === 204) return null
  const json = await response.json()
  if (!response.ok) {
    const detail =
      json.errors?.map(error => error.detail ?? error.title).join('; ') ?? response.statusText
    throw new Error(`App Store Connect ${method} ${route}: ${response.status} ${detail}`)
  }
  return json
}

// Enables on the App ID every capability the entitlements need. Returns what it enabled.
export async function enableCapabilities(token, bundleIdentifier, entitlements) {
  const found = await asc(
    token,
    'GET',
    `/bundleIds?filter[identifier]=${encodeURIComponent(bundleIdentifier)}`
  )
  const bundle = found.data.find(entry => entry.attributes.identifier === bundleIdentifier)
  if (!bundle) throw new Error(`Apple has no App ID ${bundleIdentifier} on this team`)
  const current = (
    await asc(token, 'GET', `/bundleIds/${bundle.id}/bundleIdCapabilities`)
  ).data.map(entry => entry.attributes.capabilityType)
  const enabled = []
  for (const entitlement of entitlements) {
    const capability = capabilityFor(entitlement)
    if (!capability) {
      throw new Error(
        `No Apple capability is known for the entitlement ${entitlement}. Enable it by hand at ` +
          `https://developer.apple.com/account/resources/identifiers/bundleId/edit/${bundle.id}, then run this again.`
      )
    }
    if (current.includes(capability)) continue
    await asc(token, 'POST', '/bundleIdCapabilities', {
      data: {
        type: 'bundleIdCapabilities',
        attributes: { capabilityType: capability },
        relationships: { bundleId: { data: { type: 'bundleIds', id: bundle.id } } }
      }
    })
    enabled.push(capability)
  }
  return enabled
}

// The profile's state on Apple's side: ACTIVE, INVALID, EXPIRED, or null when gone.
async function appleProfileState(token, profileId) {
  try {
    return (await asc(token, 'GET', `/profiles/${profileId}`)).data.attributes.profileState
  } catch (error) {
    if (/ 404 /.test(error.message)) return null
    throw error
  }
}

// The expect program that runs eas-cli on a pseudo-terminal, answers yes to
// each yes/no confirmation, and gives up on anything else it would have to type.
export function expectProgram(cwd) {
  return [
    'set timeout 180',
    `cd ${JSON.stringify(cwd)}`,
    'spawn pnpm exec eas credentials:configure-build --platform ios --profile production',
    'expect {',
    '  -re {\\(Y/n\\)} { send "y\\r"; exp_continue }',
    '  -re {[Pp]assword:|Apple ID:} { send \\003; puts "\\neas-cli asked for an Apple sign-in; the API key was not used"; exit 2 }',
    '  timeout { send \\003; puts "\\neas-cli waited three minutes, probably on a question this script cannot answer"; exit 3 }',
    '  eof',
    '}',
    'catch wait result',
    'exit [lindex $result 3]',
    ''
  ].join('\n')
}

// Runs eas-cli with the key under expect, so its prompts render and get a yes.
export async function runEasConfigureBuild(key) {
  const dir = await mkdtemp(path.join(tmpdir(), 'hexbot-asc-'))
  const keyPath = path.join(dir, `AuthKey_${key.keyId}.p8`)
  const program = path.join(dir, 'configure-build.exp')
  await writeFile(keyPath, key.keyP8, { mode: 0o600 })
  await writeFile(program, expectProgram(mobile))
  const env = {
    ...process.env,
    EXPO_NO_TELEMETRY: '1',
    EXPO_ASC_API_KEY_PATH: keyPath,
    EXPO_ASC_KEY_ID: key.keyId,
    EXPO_ASC_ISSUER_ID: key.issuerId,
    EXPO_APPLE_TEAM_ID: key.teamId,
    EXPO_APPLE_TEAM_TYPE:
      process.env.EXPO_APPLE_TEAM_TYPE ?? (key.teamType === 'IN_HOUSE' ? 'IN_HOUSE' : 'INDIVIDUAL')
  }
  if (!env.CI) delete env.CI // eas-cli rejects an empty CI variable
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('expect', [program], { cwd: mobile, env, stdio: 'inherit' })
      child.on('error', error =>
        reject(
          error.code === 'ENOENT'
            ? new Error('expect is not installed (macOS has it; on Linux, apt-get install expect)')
            : error
        )
      )
      child.on('close', code =>
        code === 0
          ? resolve()
          : reject(new Error(`eas credentials:configure-build exited with ${code}`))
      )
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function main(argv) {
  const check = argv.includes('--check')
  const config = await resolveConfig()
  const key = await fetchSubmissionKey(config)
  const token = ascToken(key)
  const before = await fetchStoredProfile(config)
  const missing = config.entitlements.filter(
    entitlement => !before.entitlements.includes(entitlement)
  )
  const state = await appleProfileState(token, before.id)
  console.log(
    `Stored profile ${before.id}: ${state ?? 'gone from Apple'}; ${missing.length ? `lacks ${missing.join(', ')}` : 'covers every entitlement'}`
  )
  if (check) return 0
  const enabled = await enableCapabilities(token, config.bundleIdentifier, config.entitlements)
  console.log(
    enabled.length
      ? `Enabled on the App ID: ${enabled.join(', ')}`
      : 'The App ID already has every capability'
  )
  // Enabling a capability invalidates the profile, and eas-cli replaces an
  // invalid or missing profile. A profile Apple still calls active but that
  // lacks an entitlement would pass eas-cli's check, so remove it first.
  if (missing.length && (await appleProfileState(token, before.id)) === 'ACTIVE') {
    await asc(token, 'DELETE', `/profiles/${before.id}`)
    console.log(`Deleted profile ${before.id} on Apple so eas-cli creates a new one`)
  }
  await runEasConfigureBuild(key)
  const after = await fetchStoredProfile(config)
  const still = config.entitlements.filter(entitlement => !after.entitlements.includes(entitlement))
  if (still.length) {
    console.error(`The new profile ${after.id} still lacks ${still.join(', ')}`)
    return 1
  }
  console.log(
    `Stored profile ${after.id} covers ${config.entitlements.join(', ') || 'no entitlements'}`
  )
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
