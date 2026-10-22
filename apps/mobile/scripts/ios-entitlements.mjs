// Guards the iOS entitlements the production provisioning profile on EAS supports.
//
// A nightly TestFlight build runs non-interactively and uses the stored profile
// as it is; EAS never syncs capabilities with Apple from the cloud. So an
// entitlement that app.config.ts starts to need after the profile was made
// (expo-notifications adds aps-environment, for example) fails every nightly
// in Xcode until someone regenerates the profile from a checkout.
//
// Two checks, both described in README.md, "iOS capabilities and the
// provisioning profile":
//   default  compares the resolved entitlements with ios-entitlements.json,
//            the record of what the stored profile supports. Offline; runs in
//            `pnpm mobile:check`. `--write` updates the record.
//   --eas    downloads the stored profile from EAS and checks that it carries
//            every resolved entitlement. Needs EXPO_TOKEN or an `eas login`
//            session; runs in release.yml before the TestFlight build.
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const recordPath = path.join(mobile, 'ios-entitlements.json')
const readme = 'apps/mobile/README.md, "iOS capabilities and the provisioning profile"'

export function compareEntitlements(recorded, resolved) {
  return {
    added: resolved.filter(key => !recorded.includes(key)),
    removed: recorded.filter(key => !resolved.includes(key))
  }
}

export function explain({ added, removed }) {
  const changes = []
  if (added.length) changes.push(`added ${added.join(', ')}`)
  if (removed.length) changes.push(`removed ${removed.join(', ')}`)
  return [
    `iOS entitlements changed: ${changes.join('; ')}.`,
    'The production provisioning profile stored on EAS supports only the entitlements',
    'recorded in apps/mobile/ios-entitlements.json. A cloud build uses that profile as it',
    'is, so the next nightly TestFlight build would fail in Xcode.',
    `Regenerate the profile first (${readme}), then record the new list:`,
    '  pnpm --filter @hexbot/mobile run entitlements --write'
  ].join('\n')
}

export function explainMissing(profileId, missing) {
  return [
    `The production provisioning profile stored on EAS (${profileId}) lacks: ${missing.join(', ')}.`,
    'A cloud build uses that profile as it is, so the TestFlight build would fail in Xcode',
    'with "Provisioning profile ... doesn\'t include the ... entitlement".',
    `Regenerate the profile from a checkout (${readme}), then run this check again:`,
    '  pnpm --filter @hexbot/mobile run entitlements --eas'
  ].join('\n')
}

// Entitlement keys at the top level of a .mobileprovision's Entitlements
// dictionary. The file is CMS-signed binary around an XML plist, so this reads
// the XML without a plist parser.
export function profileEntitlements(base64) {
  const text = Buffer.from(base64, 'base64').toString('latin1')
  const start = text.indexOf('<key>Entitlements</key>')
  if (start < 0) throw new Error('The provisioning profile has no Entitlements dictionary')
  const keys = []
  let depth = 0
  const tag = /<(\/?)(dict|array|key)>/g
  tag.lastIndex = text.indexOf('<dict>', start)
  for (let match = tag.exec(text); match; match = tag.exec(text)) {
    const [, close, name] = match
    if (name === 'key') {
      if (!close && depth === 1)
        keys.push(text.slice(tag.lastIndex, text.indexOf('</key>', tag.lastIndex)))
      continue
    }
    depth += close ? -1 : 1
    if (depth === 0) break
  }
  return keys.sort()
}

export async function readRecord() {
  const record = JSON.parse(await readFile(recordPath, 'utf8'))
  if (!Array.isArray(record.entitlements))
    throw new Error(`${recordPath}: "entitlements" must be an array`)
  return record
}

export async function resolveConfig() {
  const expo = path.join(mobile, 'node_modules/.bin/expo')
  const { stdout } = await promisify(execFile)(expo, ['config', '--type', 'introspect', '--json'], {
    cwd: mobile,
    env: { ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1' },
    maxBuffer: 16 * 1024 * 1024
  })
  const config = JSON.parse(stdout)
  return {
    entitlements: Object.keys(config.ios?.entitlements ?? {}).sort(),
    projectId: config.extra?.eas?.projectId,
    bundleIdentifier: config.ios?.bundleIdentifier
  }
}

export async function resolveEntitlements() {
  return (await resolveConfig()).entitlements
}

async function easAuthHeader() {
  if (process.env.EXPO_TOKEN) return { authorization: `Bearer ${process.env.EXPO_TOKEN}` }
  try {
    const state = JSON.parse(await readFile(path.join(homedir(), '.expo/state.json'), 'utf8'))
    if (state.auth?.sessionSecret) return { 'expo-session': state.auth.sessionSecret }
  } catch {}
  throw new Error(
    'Set EXPO_TOKEN or run `pnpm exec eas login` in apps/mobile to read the stored profile'
  )
}

// One query against the EAS GraphQL API, as EXPO_TOKEN or the `eas login` session.
export async function easQuery(query, variables) {
  const response = await fetch('https://api.expo.dev/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await easAuthHeader()) },
    body: JSON.stringify({ query, variables })
  })
  const { data, errors } = await response.json()
  if (errors?.length) throw new Error(`EAS: ${errors.map(error => error.message).join('; ')}`)
  return data
}

// The App Store provisioning profile stored on EAS for the bundle identifier.
export async function fetchStoredProfile({ projectId, bundleIdentifier }) {
  const data = await easQuery(
    `query($appId: String!) { app { byId(appId: $appId) { iosAppCredentials(filter: { appleAppIdentifierId: null }) {
      appleAppIdentifier { bundleIdentifier }
      iosAppBuildCredentialsList { iosDistributionType provisioningProfile { developerPortalIdentifier status provisioningProfile } }
    } } } }`,
    { appId: projectId }
  )
  const credentials = data.app.byId.iosAppCredentials.find(
    entry => entry.appleAppIdentifier.bundleIdentifier === bundleIdentifier
  )
  const build = credentials?.iosAppBuildCredentialsList.find(
    entry => entry.iosDistributionType === 'APP_STORE'
  )
  if (!build?.provisioningProfile) {
    throw new Error(
      `EAS has no App Store provisioning profile for ${bundleIdentifier}; build once from a checkout (${readme})`
    )
  }
  const { developerPortalIdentifier, status, provisioningProfile } = build.provisioningProfile
  return {
    id: developerPortalIdentifier,
    status,
    entitlements: profileEntitlements(provisioningProfile)
  }
}

export async function main(argv) {
  const write = argv.includes('--write')
  const config = await resolveConfig()
  const resolved = config.entitlements
  if (argv.includes('--eas')) {
    const profile = await fetchStoredProfile(config)
    const missing = resolved.filter(key => !profile.entitlements.includes(key))
    if (profile.status !== 'active') {
      console.error(
        `The production provisioning profile stored on EAS (${profile.id}) is ${profile.status}; regenerate it (${readme}).`
      )
      return 1
    }
    if (missing.length) {
      console.error(explainMissing(profile.id, missing))
      return 1
    }
    console.log(
      `Stored provisioning profile ${profile.id} covers ${resolved.join(', ') || 'no entitlements'}`
    )
    return 0
  }
  const record = await readRecord()
  const diff = compareEntitlements(record.entitlements, resolved)
  if (!diff.added.length && !diff.removed.length) {
    console.log(`iOS entitlements match ios-entitlements.json: ${resolved.join(', ') || 'none'}`)
    return 0
  }
  if (write) {
    const list = resolved.map(key => JSON.stringify(key)).join(', ')
    await writeFile(
      recordPath,
      `{\n  "note": ${JSON.stringify(record.note)},\n  "entitlements": [${list}]\n}\n`
    )
    console.log(`Recorded iOS entitlements: ${resolved.join(', ') || 'none'}`)
    console.log(
      `Regenerate the production provisioning profile before the next nightly (${readme}).`
    )
    return 0
  }
  console.error(explain(diff))
  return 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
