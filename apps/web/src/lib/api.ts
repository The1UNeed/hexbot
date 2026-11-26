/**
 * Typed wrappers for every daemon method the client calls: the `hexbot.*`
 * surface and chat contract from docs/api.md.
 * Everything goes through the active RPC client, so
 * a call before the connection is up rejects with `NotConnectedError`.
 */

import { JsonRpcGatewayError } from '@hermes/shared'

import { useConnection } from '../stores/connection'

import { type AskCall, askExpectedSent, asksCompatible, asksOf, askTarget } from './asks'
import { targetOrigin } from './daemon-origin'
import { mediaSource, splitAttached } from './media'
import { type HexbotRpcClient, rpcCall } from './rpc'
import { settledCard } from './settled-cards'
import { toMillis } from './time'
import type {
  AccountSignIn,
  ApprovalChoice,
  ApprovalRequest,
  Bot,
  BotCreateInput,
  BotUpdatePatch,
  ClarifyQuestion,
  ClarifyRequest,
  ClarifyRequestPayload,
  Computer,
  ComputerQuality,
  ComputerSize,
  ComputerStatus,
  Connector,
  ConnectorTest,
  ContextUsage,
  DaemonInfo,
  DaemonUpdateStatus,
  Device,
  DiscordMode,
  DiscordStatus,
  EmailDraftAnswer,
  HeartbeatStatus,
  Message,
  ModelOption,
  NetworkInfo,
  PairingCode,
  PasswordKeyStore,
  PasswordLogin,
  PluginAnswer,
  PluginKind,
  PluginsList,
  Provider,
  ProviderLogin,
  Reaction,
  ReactionsChanged,
  Room,
  RoomEvent,
  RoomLimits,
  RoomTurnAsk,
  Section,
  Settings,
  SkillInfo,
  Usage
} from './types'
import type {
  CurrentUser,
  DiagnosticsLogs,
  DiagnosticsSnapshot,
  DiagnosticsSpan,
  UsageReport,
  UsageSummary
} from './types'

/** Raw history row as projected by Hexbot `session.history`. */
export interface HistoryRow {
  nested_calls?: {
    calls: {
      id: string
      name: string
      arguments?: unknown
      durationMs?: number
      result?: unknown
      section_id?: string
      status: string
      error?: string
    }[]
  }
  args?: unknown
  context?: string
  display_kind?: string
  name?: string
  role: string
  row_id?: string
  section_id?: string
  text?: string
  [key: string]: unknown
}

export interface BotMemory {
  cap: number
  memory_md: string
  /** When MEMORY.md last changed, in Unix seconds; null before it exists. Older daemons leave it out. */
  updated_at?: null | number
}

/** One day of a bot's notes: the local day it was filed under and its text. */
export interface BotNotesDay {
  date: string
  text: string
}

/**
 * A bot's notes by day, newest first. `today` is the daemon's current local
 * day, the one its files are named by. Days older than `retention_days` are removed.
 */
export interface BotNotes {
  cap: number
  days: BotNotesDay[]
  retention_days: number
  today: string
}

/** The About you text: written by the user, read by every one of their bots. */
export interface UserMemory {
  cap: number
  text: string
  updated_at: null | number
}

export interface ModelList {
  all: ModelOption[]
  curated: ModelOption[]
  error?: string
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

export function daemonInfo(): Promise<DaemonInfo> {
  return rpcCall<DaemonInfo>('hexbot.info')
}

/** Ask the daemon to update itself to `version` (docs/api.md, "Updates"). */
export function updateRequest(
  version: string
): Promise<{ accepted: boolean; method: 'desktop' | 'service'; version: string }> {
  return rpcCall('hexbot.update.request', { version })
}

export function updateStatus(): Promise<DaemonUpdateStatus> {
  return rpcCall<DaemonUpdateStatus>('hexbot.update.status')
}

export function settingsGet(): Promise<Settings> {
  return rpcCall<Settings>('hexbot.settings.get')
}

export function settingsSet(patch: Partial<Settings>): Promise<Settings> {
  return rpcCall<Settings>('hexbot.settings.set', { patch })
}

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

export function botsList(): Promise<{ bots: Bot[] }> {
  return rpcCall<{ bots: Bot[] }>('hexbot.bots.list')
}

export function botsGet(name: string): Promise<{ bot: Bot }> {
  return rpcCall<{ bot: Bot }>('hexbot.bots.get', { name })
}

/** A daemon from before picked faces refuses the field; it keeps the face PNG as a photo. */
function rejectsFace(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: number; message?: string }

  return code === 4201 && message === 'unknown bot field: face'
}

/** Send a bot write, again without `face` when the daemon does not know the field. */
async function withFace<T>(
  method: string,
  params: Record<string, unknown> & { face?: unknown }
): Promise<T> {
  try {
    return await rpcCall<T>(method, params)
  } catch (error) {
    if (params.face === undefined || !rejectsFace(error)) {
      throw error
    }

    const rest = { ...params }
    delete rest.face

    return rpcCall<T>(method, rest)
  }
}

export function botsCreate(input: BotCreateInput): Promise<{ bot: Bot; section: Section }> {
  return withFace<{ bot: Bot; section: Section }>('hexbot.bots.create', { ...input })
}

/** Create HexBot, the primary bot, on the default model. */
export function botsCreatePrimary(
  input: Partial<
    Pick<
      BotCreateInput,
      'avatar' | 'display_name' | 'face' | 'model' | 'provider' | 'reasoning_effort'
    >
  > = {}
): Promise<{ bot: Bot; section: Section }> {
  return rpcCall<{ bot: Bot; section: Section }>('hexbot.bots.create_primary', { ...input })
}

/** Make an existing bot the primary bot. Refused once there is one. */
export function botsSetPrimary(name: string): Promise<{ bot: Bot }> {
  return rpcCall<{ bot: Bot }>('hexbot.bots.set_primary', { name })
}

/** Have the daemon submit a new bot's hidden first prompt into its section. */
export function botsIntroduce(
  name: string,
  section: string
): Promise<{ section: Section; submitted: boolean }> {
  return rpcCall<{ section: Section; submitted: boolean }>('hexbot.bots.introduce', {
    name,
    section
  })
}

export function botsUpdate(name: string, patch: BotUpdatePatch): Promise<{ bot: Bot }> {
  return withFace<{ bot: Bot }>('hexbot.bots.update', { name, ...patch })
}

/** Pin a bot's chat in the list, or unpin it. */
export function botsPin(name: string, pinned: boolean): Promise<{ bot: Bot }> {
  return rpcCall<{ bot: Bot }>('hexbot.bots.pin', { name, pinned })
}

export function botsDelete(name: string): Promise<{ deleted: boolean }> {
  return rpcCall<{ deleted: boolean }>('hexbot.bots.delete', { name })
}

/** Dismiss a bot's Stopped state without fixing anything. */
export function botsClearStatus(name: string): Promise<{ bot: Bot }> {
  return rpcCall<{ bot: Bot }>('hexbot.bots.clear_status', { name })
}

// ---------------------------------------------------------------------------
// Connectors and skills
// ---------------------------------------------------------------------------

export function connectorsList(bot?: string): Promise<{ connectors: Connector[] }> {
  return rpcCall<{ connectors: Connector[] }>('hexbot.connectors.list', bot ? { bot } : {})
}

export interface ConnectorSetupInput {
  bot?: string
  bot_only?: boolean
  enable_for_bot?: boolean
  id: string
  provider?: string
  values: Record<string, string>
}

export function connectorsSetup(
  input: ConnectorSetupInput
): Promise<{ connector: Connector; test: ConnectorTest }> {
  return rpcCall<{ connector: Connector; test: ConnectorTest }>('hexbot.connectors.setup', {
    ...input
  })
}

export function connectorsTest(id: string, bot?: string): Promise<ConnectorTest> {
  return rpcCall<ConnectorTest>('hexbot.connectors.test', { id, ...(bot ? { bot } : {}) })
}

export function connectorsClear(
  id: string,
  options: { bot?: string; bot_only?: boolean } = {}
): Promise<{ connector: Connector }> {
  return rpcCall<{ connector: Connector }>('hexbot.connectors.clear', { id, ...options })
}

// ---------------------------------------------------------------------------
// Google and Microsoft accounts
// ---------------------------------------------------------------------------

/**
 * Starts a sign-in for the connector `service`. `also` names other
 * connectors of the same account to connect with the same sign-in.
 */
/**
 * Starts a sign-in. Google returns to 127.0.0.1: by default the daemon's
 * port; `port`, the desktop app's own; `'connect'`, through Hex Connect,
 * for a browser on another computer (a daemon without Connect stays on
 * loopback, where the address is pasted back).
 */
export function accountsSignInStart(
  service: string,
  also: string[] = [],
  back?: 'connect' | number
): Promise<AccountSignIn> {
  return rpcCall<AccountSignIn>('hexbot.accounts.sign_in_start', {
    service,
    ...(also.length ? { also } : {}),
    ...(back === 'connect' ? { return_via: 'connect' } : {}),
    ...(typeof back === 'number' ? { return_port: back } : {})
  })
}

export function accountsSignInPoll(loginId: string): Promise<AccountSignIn> {
  return rpcCall<AccountSignIn>('hexbot.accounts.sign_in_poll', { login_id: loginId })
}

/** Finishes a Google sign-in with the address the browser ended on. */
export function accountsSignInFinish(loginId: string, url: string): Promise<AccountSignIn> {
  return rpcCall<AccountSignIn>('hexbot.accounts.sign_in_finish', { login_id: loginId, url })
}

export function accountsSignInCancel(loginId: string): Promise<AccountSignIn> {
  return rpcCall<AccountSignIn>('hexbot.accounts.sign_in_cancel', { login_id: loginId })
}

/** Disconnects the connector `service`; the account's other connectors stay. */
export function accountsDisconnect(service: string): Promise<{ disconnected: string }> {
  return rpcCall<{ disconnected: string }>('hexbot.accounts.disconnect', { service })
}

export function connectorsSetForBot(
  id: string,
  bot: string,
  enabled: boolean
): Promise<{ connector: Connector }> {
  return rpcCall<{ connector: Connector }>('hexbot.connectors.set_for_bot', { bot, enabled, id })
}

export interface McpServerInput {
  args?: string[]
  /** Also give the server to this bot. Saving keeps the bots it already had. */
  bot?: string
  command?: string
  env?: Record<string, string>
  name: string
  transport?: 'http' | 'sse' | 'stdio'
  url?: string
}

export function connectorsAddMcp(input: McpServerInput): Promise<{ connector: Connector }> {
  return rpcCall<{ connector: Connector }>('hexbot.connectors.add_mcp', { ...input })
}

export function connectorsRemoveMcp(name: string): Promise<{ removed: boolean }> {
  return rpcCall<{ removed: boolean }>('hexbot.connectors.remove_mcp', { name })
}

// ---------------------------------------------------------------------------
// Plugins: connectors, MCP servers, skills, built-in tools and packages
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

export interface PasswordsList {
  bots: string[]
  logins: PasswordLogin[]
  store: PasswordKeyStore
}

/** A new login (no `id`) or a change; fields left out stay. An empty `code` removes it. */
export interface PasswordInput {
  bots?: null | string[]
  code?: string
  id?: string
  notes?: string
  password?: string
  title?: string
  url?: string
  username?: string
}

export function passwordsList(): Promise<PasswordsList> {
  return rpcCall<PasswordsList>('hexbot.passwords.list', {})
}

export function passwordsSave(input: PasswordInput): Promise<{ login: PasswordLogin }> {
  return rpcCall<{ login: PasswordLogin }>('hexbot.passwords.save', { ...input })
}

export function passwordsSetBots(
  id: string,
  bots: null | string[]
): Promise<{ login: PasswordLogin }> {
  return rpcCall<{ login: PasswordLogin }>('hexbot.passwords.set_bots', { bots, id })
}

export function passwordsDelete(id: string): Promise<unknown> {
  return rpcCall('hexbot.passwords.delete', { id })
}

/** The password and the one-time code for now, for the owner only. */
export function passwordsReveal(
  id: string
): Promise<{ code: null | { code: string; valid_for: number }; password: string }> {
  return rpcCall('hexbot.passwords.reveal', { id })
}

export function pluginsList(): Promise<PluginsList> {
  return rpcCall<PluginsList>('hexbot.plugins.list', {})
}

export function pluginsSetBots(kind: PluginKind, id: string, bots: string[]): Promise<unknown> {
  return rpcCall('hexbot.plugins.set_bots', { bots, id, kind })
}

export interface PluginInstallInput {
  /** The bots it starts on for; every bot when left out. */
  bots?: string[]
  description?: string
  mcp?: {
    args?: string[]
    command?: string
    env?: Record<string, string>
    headers?: Record<string, string>
    url?: string
  }
  name: string
  skills?: { content: string; name: string }[]
}

export function pluginsInstall(input: PluginInstallInput): Promise<unknown> {
  return rpcCall('hexbot.plugins.install', { ...input })
}

/** Values set to null are removed; names left out keep their value. */
export interface PluginConfigureInput {
  args?: string[]
  command?: string
  env?: Record<string, null | string>
  headers?: Record<string, null | string>
  url?: string
}

export function pluginsConfigure(
  kind: PluginKind,
  id: string,
  change: PluginConfigureInput
): Promise<unknown> {
  return rpcCall('hexbot.plugins.configure', { id, kind, ...change })
}

/** Removes a package, with its server and skills, for every bot. */
export function pluginsRemove(id: string): Promise<{ removed: boolean }> {
  return rpcCall<{ removed: boolean }>('hexbot.plugins.remove', { id, kind: 'package' })
}

/** A skill's switch for every bot, under each bot's own. */
export function skillsSetGlobal(name: string, enabled: boolean): Promise<unknown> {
  return rpcCall('hexbot.skills.set_global', { enabled, name })
}

/**
 * Adds a skill to your library. It never replaces one: a name already in
 * use, or a skill built into Hexbot, is refused. `botsDisabled` starts it
 * off for those bots.
 */
export function skillsSave(input: {
  botsDisabled?: string[]
  content: string
  name: string
}): Promise<unknown> {
  return rpcCall('hexbot.skills.save', {
    content: input.content,
    create: true,
    name: input.name,
    ...(input.botsDisabled?.length ? { bots_disabled: input.botsDisabled } : {})
  })
}

/** Deletes a skill you added, for every bot. */
export function skillsDelete(name: string): Promise<unknown> {
  return rpcCall('hexbot.skills.delete', { name })
}

export function skillsList(bot: string): Promise<{ skills: SkillInfo[] }> {
  return rpcCall<{ skills: SkillInfo[] }>('hexbot.skills.list', { bot })
}

// ---------------------------------------------------------------------------
// Rooms and bot activity
// ---------------------------------------------------------------------------

export interface RoomCreateInput {
  approval_mode?: string
  limits?: RoomLimits
  main_bot?: string
  members: string[]
  name: string
}

export function roomsList(includeArchived = false): Promise<{ rooms: Room[] }> {
  return rpcCall<{ rooms: Room[] }>('hexbot.rooms.list', { include_archived: includeArchived })
}

export function roomsGet(id: string): Promise<{ room: Room }> {
  return rpcCall<{ room: Room }>('hexbot.rooms.get', { id })
}

export function roomsCreate(input: RoomCreateInput): Promise<{ room: Room }> {
  return rpcCall<{ room: Room }>('hexbot.rooms.create', { ...input })
}

export function roomsUpdate(
  id: string,
  patch: Partial<Pick<Room, 'approval_mode' | 'limits' | 'main_bot' | 'name'>>
): Promise<{ room: Room }> {
  return rpcCall<{ room: Room }>('hexbot.rooms.update', { id, ...patch })
}

export function roomsAddMember(id: string, bot: string): Promise<{ room: Room }> {
  return rpcCall<{ room: Room }>('hexbot.rooms.add_member', { bot, id })
}

export function roomsRemoveMember(
  id: string,
  bot: string,
  keepRoom: boolean
): Promise<{ room: Room }> {
  return rpcCall<{ room: Room }>('hexbot.rooms.remove_member', { bot, id, keep_room: keepRoom })
}

/** Only offered when a legacy daemon returns a room owned by someone else. */
export const roomsLeave = (id: string, user: string) =>
  rpcCall('hexbot.rooms.remove_member', { id, user })

export function roomsSend(
  id: string,
  text: string,
  attachments: unknown[] = []
): Promise<{ event: RoomEvent }> {
  return rpcCall<{ event: RoomEvent }>('hexbot.rooms.send', { attachments, id, text })
}

export function roomsLog(
  id: string,
  options: { after_seq?: number; before_seq?: number; limit?: number } = {}
): Promise<{ events: RoomEvent[] }> {
  return rpcCall<{ events: RoomEvent[] }>('hexbot.rooms.log', { id, ...options })
}

export function roomsStop(id: string): Promise<{ stopped: boolean }> {
  return rpcCall<{ stopped: boolean }>('hexbot.rooms.stop', { id })
}

export function roomsArchive(id: string): Promise<{ room: Room }> {
  return rpcCall<{ room: Room }>('hexbot.rooms.archive', { id })
}

export function roomsDelete(id: string): Promise<{ deleted: boolean }> {
  return rpcCall<{ deleted: boolean }>('hexbot.rooms.delete', { id })
}

export function roomsPin(id: string, pinned: boolean): Promise<{ room: Room }> {
  return rpcCall<{ room: Room }>('hexbot.rooms.pin', { id, pinned })
}

export function roomsMarkRead(id: string, seq: number): Promise<{ room: Room }> {
  return rpcCall<{ room: Room }>('hexbot.rooms.mark_read', { id, seq })
}

export interface DreamStatus {
  enabled: boolean
  last_run_at: null | number
  next_run_at: null | number
  last_status: null | string
  last_error: null | string
}
export interface Dream {
  id: string
  bot: string
  started_at: number
  finished_at?: null | number
  status: string
  summary: string
  /** The bot's memory file when the dream started and when it finished. */
  memory_before?: null | string
  memory_after?: null | string
}
export const dreamingStatus = (bot: string) =>
  rpcCall<DreamStatus>('hexbot.dreaming.status', { bot })
export const dreamingRunNow = (bot: string) =>
  rpcCall<{ job: unknown }>('hexbot.dreaming.run_now', { bot })
export const dreamingList = (bot: string, limit = 10) =>
  rpcCall<{ dreams: Dream[] }>('hexbot.dreaming.list', { bot, limit })
/** Put the bot's memory back to what it was before this dream. */
export const dreamingRestore = (id: string) =>
  rpcCall<{ bot: string; memory_md: string }>('hexbot.dreaming.restore', { id })

export const computerStatus = () => rpcCall<ComputerStatus>('hexbot.computer.status')
/** Start, stop, restart or reset; the step runs on and reports `hexbot.computer.changed`. */
export const computerStep = (step: 'reset' | 'restart' | 'start' | 'stop') =>
  rpcCall<ComputerStatus>(`hexbot.computer.${step}`)
/** Pause the bots (`user`) or resume them (`bot`); the screen takes the user's input either way. */
export const computerControl = (holder: 'bot' | 'user') =>
  rpcCall<ComputerStatus>('hexbot.computer.control', { holder })
/** A link, relative to the daemon, to the computer's screen; with `control` it takes clicks and keys. */
export const computerView = (control: boolean, quality: ComputerQuality = 'auto') =>
  rpcCall<{ control: boolean; expires_at: number; path: string }>('hexbot.computer.view', {
    control,
    quality
  })
export const computerConfigure = (size: ComputerSize) =>
  rpcCall<ComputerStatus>('hexbot.computer.configure', { size })

/** Every computer bots can use, with the bots on each (`machines.rs`). */
export const computersList = () => rpcCall<{ computers: Computer[] }>('hexbot.computers.list')
/** Give a bot one computer as an environment, or take it; its screen comes with Computer Use. */
export const computersGrant = (
  computer: string,
  capability: 'terminal',
  bot: string,
  on: boolean
) => rpcCall<{ ok: true }>('hexbot.computers.grant', { bot, capability, computer, on })
/** The bots' computer in use or not; this computer's desktop shared (set up first) or not. */
export const computersSet = (computer: 'host' | 'vm', change: { desktop?: boolean; on?: boolean }) =>
  rpcCall<{ computers: Computer[] }>('hexbot.computers.set', { computer, ...change })
/** Setup's choice for every bot made from now on: this computer's terminal and desktop. */
export const computersDefaults = (defaults: { computer_use?: boolean; host_terminal?: boolean }) =>
  rpcCall<Record<string, boolean>>('hexbot.computers.defaults', defaults)
/** Take an app off a bot's Always allow list on one computer. */
export const computersRemoveApp = (computer: string, bot: string, app: string) =>
  rpcCall<{ ok: true }>('hexbot.computers.remove_app', { app, bot, computer })
/** Forget one of the user's computers: its bots and apps go. */
export const computersForget = (computer: string) =>
  rpcCall<{ note?: string; ok: true; released?: boolean }>('hexbot.computers.forget', { computer })
/** This app offers its own computer, or withdraws it with neither. */
export const computersAttach = (offer: {
  desktop: boolean
  name: string
  os: string
  terminal: boolean
}) => rpcCall<{ attached: boolean; computer: string }>('hexbot.computers.attach', offer)
/** This app's answer to one request from the daemon, on the connection that asked. */
export const computersReply = (
  client: HexbotRpcClient,
  requestId: string,
  answer: { error?: string; result?: unknown }
) => client.call<{ ok: true }>('hexbot.computers.reply', { request_id: requestId, ...answer })

/** The bot's own Discord app, or null when it has none; `enabled`: Discord is on for it in Plugins. */
export const discordGet = (bot: string) =>
  rpcCall<{ discord: DiscordStatus | null; enabled?: boolean }>('hexbot.discord.get', { bot })
/** How the bot acts in Discord: its default, or one server's own mode (null follows the default). */
export const discordSetMode = (bot: string, mode: DiscordMode | null, guildId?: string) =>
  rpcCall<{ discord: DiscordStatus }>('hexbot.discord.set_mode', {
    bot,
    mode,
    ...(guildId ? { guild_id: guildId } : {})
  })
/** Checks the token with Discord, saves it on the daemon and connects. */
export const discordConnect = (bot: string, token: string) =>
  rpcCall<{ discord: DiscordStatus }>('hexbot.discord.connect', { bot, token })
/** Disconnects and drops the token; the bot's Discord rooms stay. */
export const discordDisconnect = (bot: string) =>
  rpcCall<{ discord: null }>('hexbot.discord.disconnect', { bot })
export const heartbeatStatus = (bot: string) =>
  rpcCall<HeartbeatStatus>('hexbot.heartbeat.status', { bot })
/** Replaces the bot's HEARTBEAT.md. */
export const heartbeatSet = (bot: string, text: string) =>
  rpcCall<HeartbeatStatus>('hexbot.heartbeat.set', { bot, text })
export const heartbeatRunNow = (bot: string) =>
  rpcCall<{ id: string }>('hexbot.heartbeat.run_now', { bot })
/** Delete a section that is not a bot's chat, such as an earlier Check-ins (4202 for a chat). */
export const sectionsDelete = (id: string) =>
  rpcCall<{ deleted: boolean }>('hexbot.sections.delete', { id })

export interface ConnectStatus {
  registered: boolean
  daemon_id: null | string
  slug: null | string
  tunnel_hostname: null | string
  tunnel_running: boolean
  last_heartbeat_at: null | number
  last_error: null | string
  identity_error?: null | string
}
export interface ConnectRegistration {
  device_code: string
  user_code: string
  verify_url: string
  interval: number
}
export const connectStatus = () => rpcCall<ConnectStatus>('hexbot.connect.status')
export const connectRegisterStart = () =>
  rpcCall<ConnectRegistration>('hexbot.connect.register_start')
export const connectRegisterPoll = (deviceCode: string) =>
  rpcCall<{ status: string }>('hexbot.connect.register_poll', { device_code: deviceCode })
export const connectDisconnect = () => rpcCall<Record<string, unknown>>('hexbot.connect.disconnect')

export const usersMe = () => rpcCall<CurrentUser>('hexbot.users.me')
/** The name you go by in rooms and on this daemon. */
export const usersMeSet = (displayName: string) =>
  rpcCall<CurrentUser>('hexbot.users.me.set', { display_name: displayName })
export const usageSummary = () => rpcCall<UsageSummary>('hexbot.usage.summary')

/** Usage by bucket, bot, model and place; `usageWindow` in lib/usage-report gives the edges. */
export const usageReport = (edges: number[]) =>
  rpcCall<UsageReport>('hexbot.usage.report', { edges })

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** Everything Settings, Diagnostics shows; `span_name` filters the span log. */
export const diagnosticsGet = (spanName?: string) =>
  rpcCall<DiagnosticsSnapshot>('hexbot.diagnostics.get', spanName ? { span_name: spanName } : {})

/** Every span of one trace, the run first. */
export const diagnosticsTrace = (trace: number) =>
  rpcCall<{ spans: DiagnosticsSpan[]; trace: number }>('hexbot.diagnostics.trace', { trace })

/**
 * One page of a file in `<home>/logs`, newest lines last. Without `file`, the
 * daemon's own output; `before` continues with older lines.
 */
export const diagnosticsLogs = (params: {
  before?: number
  errors?: boolean
  file?: string
  query?: string
}) => rpcCall<DiagnosticsLogs>('hexbot.diagnostics.logs', params)

export const gatewayPing = () => rpcCall<{ pong: boolean }>('gateway.ping')

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export function sectionsList(
  options: { bot?: string; include_archived?: boolean; include_threads?: boolean } = {}
): Promise<{
  sections: Section[]
}> {
  const listed = rpcCall<{ sections: Section[] }>('hexbot.sections.list', { ...options })

  // A daemon with one chat per bot names each section's purpose itself.
  return useConnection.getState().daemon?.one_chat === true
    ? listed
    : listed.then(async result => ({ ...result, sections: await withPurpose(result.sections) }))
}

/**
 * A daemon with check-ins from before one chat per bot names no section's
 * purpose. Its check-ins status names the Check-ins section, which is never
 * a bot's chat. Daemons that name purposes, or have no check-ins, are as they say.
 */
async function withPurpose(sections: Section[] = []): Promise<Section[]> {
  if (!sections.length || sections.some(section => 'purpose' in section)) {
    return sections
  }

  const checkins = await rpcCall<{ section_id?: null | string }>('hexbot.checkins.status')
    .then(status => status.section_id)
    .catch(() => null)

  return sections.map(section =>
    section.id === checkins ? { ...section, purpose: 'checkins' } : section
  )
}

/** The thread on `bot` in which `peer` asks it for help; null until the first ask. Owner only. */
export function sectionsThread(bot: string, peer: string): Promise<{ section: Section | null }> {
  return rpcCall<{ section: Section | null }>('hexbot.sections.thread', { bot, peer })
}

/** Every reaction in a bot's chat, oldest first. Owner only. */
export function reactionsList(sectionId: string): Promise<{ reactions: Reaction[] }> {
  return rpcCall<{ reactions: Reaction[] }>('hexbot.reactions.list', { section_id: sectionId })
}

/** Leaves your emoji on one of the bot's messages; `null` takes it back. */
export function reactionsSet(
  sectionId: string,
  messageId: string,
  emoji: null | string
): Promise<ReactionsChanged> {
  return rpcCall<ReactionsChanged>('hexbot.reactions.set', {
    emoji,
    message_id: messageId,
    section_id: sectionId
  })
}

/** A bot's one chat with you; the daemon makes it on first use. */
export function sectionsCreate(bot: string): Promise<{ section: Section }> {
  return rpcCall<{ section: Section }>('hexbot.sections.create', { bot })
}

/** Brings an archived section back. A daemon that keeps one chat per bot does it on create. */
export function sectionsUnarchive(id: string): Promise<{ section: Section }> {
  return rpcCall<{ section: Section }>('hexbot.sections.unarchive', { id })
}

export interface SectionOpened {
  /** Active or settled `message_bot` asks from the running turn; older daemons leave it out. */
  asks?: RoomTurnAsk[]
  /** Whether a turn runs at this read; older daemons leave it out. */
  busy?: boolean
  /** How full the section's context is; see `ContextUsage`. */
  context?: ContextUsage
  messages: HistoryRow[]
  /** A clarify question the bot is still waiting on (same shape as the event, plus locked answers). */
  pending_clarify?: ClarifyRequestPayload & { answers?: Record<string, string> }
  /** Every approval and question still waiting at this read; older daemons leave it out. */
  pending_requests?: string[]
  section: Section
  /** Send it with the next read of this chat to get only what came after; older daemons leave it out. */
  history_cursor?: string
  /** True when `messages` follow the rows the cursor was sent with; false means the whole history. */
  history_delta?: boolean
}

/** With the cursor of the rows this app holds, the daemon sends only the rows after them. */
export function sectionsOpen(id: string, historyCursor?: string): Promise<SectionOpened> {
  return rpcCall<SectionOpened>('hexbot.sections.open', {
    id,
    ...(historyCursor && { history_cursor: historyCursor })
  })
}

export interface SectionHistory {
  history_cursor: string
  history_delta: boolean
  messages: HistoryRow[]
}

/** A chat's stored history without starting its bot (`section_history` daemons). */
export function sectionsHistory(id: string, historyCursor?: string): Promise<SectionHistory> {
  return rpcCall<SectionHistory>('hexbot.sections.history', {
    id,
    ...(historyCursor && { history_cursor: historyCursor })
  })
}

/** A full durable read; cache synchronization remains compatible with older daemons. */
export function sessionHistory(
  sessionId: string,
  historyCursor?: string
): Promise<{ history_cursor?: string; history_delta?: boolean; messages: HistoryRow[] }> {
  return rpcCall('session.history', {
    session_id: sessionId,
    ...(historyCursor && { history_cursor: historyCursor })
  })
}

export function sectionsMarkRead(id: string): Promise<{ section: Section }> {
  return rpcCall<{ section: Section }>('hexbot.sections.mark_read', { id })
}

export function sectionsTouch(id: string): Promise<{ section: Section }> {
  return rpcCall<{ section: Section }>('hexbot.sections.touch', { id })
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export function userMemoryGet(): Promise<UserMemory> {
  return rpcCall<UserMemory>('hexbot.memory.user.get')
}

export function userMemorySet(text: string): Promise<UserMemory> {
  return rpcCall<UserMemory>('hexbot.memory.user.set', { text })
}

export function botMemoryGet(bot: string): Promise<BotMemory> {
  return rpcCall<BotMemory>('hexbot.memory.bot.get', { bot })
}

export function botMemorySet(bot: string, memoryMd: string): Promise<BotMemory> {
  return rpcCall<BotMemory>('hexbot.memory.bot.set', { bot, memory_md: memoryMd })
}

/** A window event naming a bot whose memory a restored dream replaced, so open copies read it again. */
export const MEMORY_RESTORED = 'hexbot:memory-restored'

export function botNotesList(bot: string): Promise<BotNotes> {
  return rpcCall<BotNotes>('hexbot.memory.notes.list', { bot })
}

/** The daemon refuses a notes write when the day changed since `expected` was loaded. */
export const NOTES_CHANGED = 4209

/**
 * Write one day's notes as given; an empty text removes the day. `expected`
 * is the text the editor loaded: the daemon answers NOTES_CHANGED instead of
 * writing over a note the bot added since.
 */
export function botNotesSet(
  bot: string,
  date: string,
  text: string,
  expected?: string
): Promise<BotNotesDay> {
  return rpcCall<BotNotesDay>('hexbot.memory.notes.set', { bot, date, expected, text })
}

export function botNotesDelete(
  bot: string,
  date: string,
  expected: string
): Promise<{ deleted: boolean }> {
  return rpcCall<{ deleted: boolean }>('hexbot.memory.notes.delete', { bot, date, expected })
}

// ---------------------------------------------------------------------------
// Providers and models
// ---------------------------------------------------------------------------

export function providersList(): Promise<{ providers: Provider[] }> {
  return rpcCall<{ providers: Provider[] }>('hexbot.providers.list')
}

export function providersSetKey(
  provider: string,
  key: string
): Promise<{ configured: boolean; provider: string }> {
  return rpcCall<{ configured: boolean; provider: string }>('hexbot.providers.set_key', {
    key,
    provider
  })
}

export function providersClearKey(
  provider: string
): Promise<{ configured: boolean; provider: string }> {
  return rpcCall<{ configured: boolean; provider: string }>('hexbot.providers.clear_key', {
    provider
  })
}

export function providersLoginStart(provider: string): Promise<ProviderLogin> {
  return rpcCall<ProviderLogin>('hexbot.providers.login_start', { provider })
}

export function providersLoginPoll(loginId: string): Promise<ProviderLogin> {
  return rpcCall<ProviderLogin>('hexbot.providers.login_poll', { login_id: loginId })
}

export function providersLoginCancel(loginId: string): Promise<ProviderLogin> {
  return rpcCall<ProviderLogin>('hexbot.providers.login_cancel', { login_id: loginId })
}

export function modelsList(provider?: string): Promise<ModelList> {
  return rpcCall<ModelList>('hexbot.models.list', provider ? { provider } : {})
}

/** Every model a provider lists right now, recommended ones first. */
export async function providerModels(provider: string): Promise<ModelOption[]> {
  const { all, curated } = await modelsList(provider)
  const recommended = new Set(curated.map(item => item.id))

  return [...curated, ...all.filter(item => !recommended.has(item.id))]
}

/** Raw Hexbot picker payload; `hexbot.models.list` is the projected form. */
export function modelOptions(): Promise<Record<string, unknown>> {
  return rpcCall<Record<string, unknown>>('model.options')
}

// ---------------------------------------------------------------------------
// Network, pairing and devices
// ---------------------------------------------------------------------------

export function networkGet(): Promise<NetworkInfo> {
  return rpcCall<NetworkInfo>('hexbot.network.get')
}

export function networkSet(lanEnabled: boolean): Promise<NetworkInfo> {
  return rpcCall<NetworkInfo>('hexbot.network.set', { lan_enabled: lanEnabled })
}

export function pairingCode(): Promise<PairingCode> {
  return rpcCall<PairingCode>('hexbot.pairing.code')
}

export function devicesList(): Promise<{ devices: Device[] }> {
  return rpcCall<{ devices: Device[] }>('hexbot.devices.list')
}

export function devicesRevoke(id: string): Promise<{ revoked: boolean }> {
  return rpcCall<{ revoked: boolean }>('hexbot.devices.revoke', { id })
}

// ---------------------------------------------------------------------------
// Hexbot chat
// ---------------------------------------------------------------------------

export interface PromptSubmitOptions {
  input_id?: string
  attachments?: string[]
  display_kind?: 'hidden'
  /** Stop a reply in progress first, so this message goes next. */
  interrupt?: boolean
  queued?: boolean
  surface?: string
}

export function promptSubmit(
  sessionId: string,
  text: string,
  options: PromptSubmitOptions = {}
): Promise<{ status: string; input_id?: string }> {
  return rpcCall<{ status: string; input_id?: string }>('prompt.submit', {
    session_id: sessionId,
    text,
    ...options
  })
}

export function sessionInterrupt(sessionId: string): Promise<{ status: string }> {
  return rpcCall<{ status: string }>('session.interrupt', { session_id: sessionId })
}

/**
 * Take back your latest message in a bot's chat, named by its input id or
 * history row id. A turn working on it stops first; the bot forgets it and
 * everything after it. Answers with the message text.
 */
export function sessionRecall(
  sessionId: string,
  message: { inputId?: string; rowId?: string }
): Promise<{ recalled: boolean; text: string }> {
  return rpcCall<{ recalled: boolean; text: string }>('session.recall', {
    session_id: sessionId,
    ...(message.inputId && { input_id: message.inputId }),
    ...(message.rowId && { row_id: message.rowId })
  })
}

export function sessionUsage(sessionId: string): Promise<{ usage: Usage }> {
  return rpcCall<{ usage: Usage }>('session.usage', { session_id: sessionId })
}

/** Per-section model override; never writes the global config. */
export function setSectionModel(
  sessionId: string,
  model: string,
  options: { confirmExpensiveModel?: boolean } = {}
): Promise<{ confirm_message?: string; confirm_required?: boolean }> {
  return rpcCall('config.set', {
    confirm_expensive_model: options.confirmExpensiveModel ?? false,
    key: 'model',
    session_id: sessionId,
    value: model
  })
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export function approvalRespond(
  sessionId: string,
  requestId: string,
  choice: ApprovalChoice,
  answer?: EmailDraftAnswer | PluginAnswer | { password: string; username: string }
): Promise<{ resolved: boolean }> {
  return rpcCall<{ resolved: boolean }>('approval.respond', {
    choice,
    request_id: requestId,
    session_id: sessionId,
    ...answer
  })
}

/** Answer a clarify question; `questionId` locks one question of a batch. */
export function clarifyRespond(
  sessionId: string,
  requestId: string,
  answer: string,
  questionId?: string
): Promise<{ remaining?: string[]; status: string }> {
  return rpcCall<{ remaining?: string[]; status: string }>('clarify.respond', {
    answer,
    request_id: requestId,
    session_id: sessionId,
    ...(questionId ? { question_id: questionId } : {})
  })
}

/** Delivery acknowledgement; sent as soon as an approval card is shown. */
export function approvalReceived(
  sessionId: string,
  requestId: string
): Promise<{ acknowledged: boolean }> {
  return rpcCall<{ acknowledged: boolean }>('approval.received', {
    request_id: requestId,
    session_id: sessionId
  })
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export interface AttachResult {
  attached?: boolean
  count?: number
  name?: string
  path?: string
  ref_text?: string
  [key: string]: unknown
}

export function imageAttachBytes(
  sessionId: string,
  contentBase64: string,
  filename?: string
): Promise<AttachResult> {
  return rpcCall<AttachResult>('image.attach_bytes', {
    content_base64: contentBase64,
    session_id: sessionId,
    ...(filename ? { filename } : {})
  })
}

export function pdfAttach(sessionId: string, contentBase64: string): Promise<AttachResult> {
  return rpcCall<AttachResult>('pdf.attach', {
    content_base64: contentBase64,
    session_id: sessionId
  })
}

export function fileAttach(
  sessionId: string,
  dataUrl: string,
  name: string
): Promise<AttachResult> {
  return rpcCall<AttachResult>('file.attach', { data_url: dataUrl, name, session_id: sessionId })
}

/** A file opened beside the chat: text to edit, or its bytes to show. */
export interface OpenedFile {
  mediaUrl?: string
  data_url?: string
  mime: string
  /** Milliseconds since the epoch, for display. */
  modified: number
  name: string
  path: string
  size: number
  text?: string
  /** For editable text, its content hash. A save passes it back to catch the bot's changes. */
  version: string
}

/** Reads a file the bot can reach: its working folder, artifacts, or this chat's attachments. */
export async function filesRead(sessionId: string, path: string): Promise<OpenedFile> {
  const target = useConnection.getState().target
  const origin = targetOrigin(target ?? { kind: 'local' })

  const file = await rpcCall<OpenedFile & { media_path?: string }>('hexbot.files.read', {
    path,
    session_id: sessionId,
    stream_media: true
  })

  return { ...file, mediaUrl: mediaSource(origin, file.media_path) }
}

/** Saves the user's edit; refused with 4209 when the file is no longer at `version`. */
export function filesWrite(
  sessionId: string,
  path: string,
  text: string,
  version?: string
): Promise<{ modified: number; path: string; size: number; version: string }> {
  return rpcCall('hexbot.files.write', {
    path,
    session_id: sessionId,
    text,
    ...(version ? { version } : {})
  })
}

/** `data:<mime>;base64,<payload>` for the whole file. */
export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.addEventListener('load', () => {
      resolve(String(reader.result ?? ''))
    })
    reader.addEventListener('error', () => {
      reject(reader.error ?? new Error('could not read the file'))
    })
    reader.readAsDataURL(file)
  })
}

export function base64FromDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')

  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1)
}

export function attachmentKind(mime: string, name: string): 'file' | 'image' | 'pdf' {
  if (mime.startsWith('image/')) {
    return 'image'
  }

  if (mime === 'application/pdf' || name.toLowerCase().endsWith('.pdf')) {
    return 'pdf'
  }

  return 'file'
}

/** How much of a file each `attachments.part` carries. */
export const PART_BYTES = 768 * 1024

/** Sessions whose daemon refused parts once: they are not asked again. */
const wholeOnly = new Set<string>()

/** A new daemon process, as after an update, may take parts: ask again. */
export function forgetWholeOnly() {
  wholeOnly.clear()
}

/** A daemon from before a method, such as part uploads or computers. */
export function unknownMethod(error: unknown): boolean {
  return (
    error instanceof JsonRpcGatewayError &&
    (error.code === -32601 || /unknown (runtime )?method|method not found/i.test(error.message))
  )
}

/**
 * Sends a file to the daemon in parts, `onProgress` hearing the share it
 * has, and returns the upload's name for the attach call. Null from a daemon
 * that takes files only whole.
 */
async function sendParts(
  sessionId: string,
  file: File,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal
): Promise<null | string> {
  if (wholeOnly.has(sessionId)) {
    return null
  }

  const upload = newInputId()

  for (let offset = 0; offset === 0 || offset < file.size; offset += PART_BYTES) {
    signal?.throwIfAborted()
    const data = base64FromDataUrl(await readFileAsDataUrl(file.slice(offset, offset + PART_BYTES)))
    signal?.throwIfAborted()

    try {
      await rpcCall('attachments.part', { data, offset, session_id: sessionId, upload })
    } catch (error) {
      if (offset === 0 && unknownMethod(error)) {
        wholeOnly.add(sessionId)

        return null
      }

      throw error
    }

    // Whole only once the daemon has staged it, which for a PDF means drawing its pages.
    onProgress?.(file.size ? Math.min(0.99, (offset + PART_BYTES) / file.size) : 0.99)
  }

  return upload
}

/**
 * A daemon from before part uploads, asked to stage a file ahead of Send. It
 * cannot take a file back either, so the file stays here until Send.
 */
export class WholeFilesOnly extends Error {
  constructor() {
    super('This daemon takes files only when the message is sent.')
    this.name = 'WholeFilesOnly'
  }
}

/**
 * Stage one file for the next `prompt.submit`, picking the right Hexbot
 * method from its type. It goes in parts, so `onProgress` hears how much the
 * daemon has, 0 to 1; a daemon from before part uploads gets it whole, or,
 * with `ahead` (staging before Send), nothing and `WholeFilesOnly`.
 * `signal` stops it once nobody wants it.
 */
export async function attachFile(
  sessionId: string,
  file: File,
  {
    ahead = false,
    onProgress,
    signal
  }: { ahead?: boolean; onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}
): Promise<AttachResult> {
  const kind = attachmentKind(file.type, file.name)
  const limitMiB = kind === 'image' ? 25 : 45

  if (file.size > limitMiB * 1024 * 1024) {
    throw new Error(`attachment exceeds ${limitMiB} MiB`)
  }

  const upload = await sendParts(sessionId, file, onProgress, signal)

  if (!upload && ahead) {
    throw new WholeFilesOnly()
  }

  const whole = async () => {
    const dataUrl = await readFileAsDataUrl(file)
    signal?.throwIfAborted()

    return dataUrl
  }

  if (kind === 'image') {
    return upload
      ? rpcCall('image.attach_bytes', { filename: file.name, session_id: sessionId, upload })
      : imageAttachBytes(sessionId, base64FromDataUrl(await whole()), file.name)
  }

  if (kind === 'pdf') {
    try {
      return upload
        ? await rpcCall('pdf.attach', { session_id: sessionId, upload })
        : await pdfAttach(sessionId, base64FromDataUrl(await whole()))
    } catch (error) {
      // A daemon without a PDF renderer (5028) still takes the PDF as a file:
      // the bot reads it with its tools, and it opens beside the chat. It
      // keeps the parts of a PDF it could not draw.
      if (!(error instanceof JsonRpcGatewayError && error.code === 5028)) {
        throw error
      }
    }
  }

  return upload
    ? rpcCall('file.attach', { name: file.name, session_id: sessionId, upload })
    : fileAttach(sessionId, await whole(), file.name)
}

/**
 * Takes back one staged upload the user removed before sending. Best effort:
 * an older daemon without the method, or an upload already gone, keeps it
 * out of the next message all the same, since a message names its uploads.
 */
export function attachmentRemove(sessionId: string, id: string): Promise<void> {
  return rpcCall('attachments.remove', { id, session_id: sessionId }).then(
    () => undefined,
    () => undefined
  )
}

// ---------------------------------------------------------------------------
// History projection
// ---------------------------------------------------------------------------

let messageCounter = 0

/** UUID correlation also works on paired LAN pages without randomUUID. */
export function newInputId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 15) | 64
  bytes[8] = (bytes[8]! & 63) | 128
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function nextMessageId(prefix = 'm'): string {
  messageCounter += 1

  return `${prefix}${messageCounter}-${Date.now().toString(36)}`
}

function parseArguments(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** The questions of a `clarify.request` payload, or of the tool call that made it. */
export function clarifyQuestions(payload: ClarifyRequestPayload): ClarifyQuestion[] {
  if (payload.questions?.length) {
    return payload.questions.map((item, index) => ({
      choices: item.choices ?? [],
      multiSelect: Boolean(item.multi_select),
      question: item.question,
      // The daemon numbers a batch the same way when the model left ids out.
      questionId: typeof item.qid === 'string' && item.qid ? item.qid : `q${index + 1}`
    }))
  }

  return [
    {
      choices: payload.choices ?? [],
      multiSelect: Boolean(payload.multi_select),
      question: payload.question ?? ''
    }
  ]
}

/**
 * A question the bot asked, rebuilt from its `clarify` call and the answer
 * the tool returned: one answer as text, a batch as a JSON object by id.
 * A question nobody answered comes back expired.
 */
function clarifyFromHistory(
  requestId: string,
  args: unknown,
  row: HistoryRow
): ClarifyRequest | null {
  // The tool only fails before it asks: the user never saw the question.
  if (!args || typeof args !== 'object' || row.is_error === true) {
    return null
  }

  const questions = clarifyQuestions(args as ClarifyRequestPayload)

  if (!questions.some(item => item.question)) {
    return null
  }

  const result = typeof row.text === 'string' ? row.text : ''
  let answers: Record<string, string> = {}

  // The private extension's reply when the question was cancelled.
  if (result && result !== 'The question was cancelled.') {
    if (questions[0]?.questionId) {
      try {
        const parsed: unknown = JSON.parse(result)

        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          answers = Object.fromEntries(
            Object.entries(parsed).map(([qid, answer]) => [qid, String(answer)])
          )
        }
      } catch {
        // Not a batch answer; the card shows as expired.
      }
    } else {
      answers = { [requestId]: result }
    }
  }

  const clarify: ClarifyRequest = {
    answers,
    questions,
    receivedAt: 0,
    requestId,
    // Settled: the card never answers, so it needs no live session.
    sessionId: ''
  }

  return clarifyAnswered(clarify) ? clarify : { ...clarify, expired: true }
}

/**
 * The answered card a tool showed (a draft, sign-in or plugin card), rebuilt
 * from its call and stored result, so it stays in the chat after a reload.
 */
function approvalFromHistory(
  call: { args: unknown; messageId?: string; name: string; status: 'error' | 'ok'; toolId: string },
  row: HistoryRow
): ApprovalRequest | null {
  const card = settledCard({ ...call, result: row.text ?? null })

  return card
    ? {
        choices: ['once', 'deny'],
        decision: card.decision,
        ...(card.failed && { failed: true }),
        form: card.form,
        messageId: call.messageId,
        ...(card.outcome && { outcome: card.outcome }),
        receivedAt: 0,
        requestId: call.toolId,
        // Settled: the card never answers, so it needs no live session.
        sessionId: '',
        toolName: call.name,
        turnId: typeof row.turn_id === 'string' ? row.turn_id : undefined
      }
    : null
}

/** Every question has its answer; questions sharing an id share one. */
export const clarifyAnswered = (clarify: ClarifyRequest) =>
  clarify.questions.every(item =>
    Object.hasOwn(clarify.answers, item.questionId ?? clarify.requestId)
  )

/**
 * Preserve `section_id` on persisted nested calls (such as a failed `message_bot`
 * ask inside `codemode`) so reopening a chat or thread still opens the exact thread.
 */
function nestedToolResult(nested: {
  error?: unknown
  result?: unknown
  section_id?: unknown
}): unknown {
  const sectionId =
    typeof nested.section_id === 'string' && nested.section_id ? nested.section_id : undefined

  if (nested.error != null) {
    if (!sectionId) {
      return nested.error
    }

    if (typeof nested.error === 'object' && !Array.isArray(nested.error)) {
      const obj = nested.error as Record<string, unknown>

      return { ...obj, section_id: obj.section_id ?? sectionId }
    }

    return { error: nested.error, section_id: sectionId }
  }

  if (nested.result != null) {
    if (!sectionId) {
      return nested.result
    }

    if (typeof nested.result === 'object' && !Array.isArray(nested.result)) {
      const obj = nested.result as Record<string, unknown>

      return { ...obj, section_id: obj.section_id ?? sectionId }
    }

    if (typeof nested.result === 'string') {
      try {
        const parsed: unknown = JSON.parse(nested.result)

        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const obj = parsed as Record<string, unknown>

          return { ...obj, section_id: obj.section_id ?? sectionId }
        }
      } catch {
        // Plain text result; keep both text and section_id.
      }
    }

    return { result: nested.result, section_id: sectionId }
  }

  return sectionId ? { section_id: sectionId } : null
}

/**
 * Turn the Hexbot `session.history` projection into transcript messages.
 * Tool rows fold into the assistant message that issued their call, matching how
 * live `tool.start` / `tool.complete` events are rendered.
 */
/**
 * Restored messages get `createdAt: 0`, which marks them as history; the
 * time their last row was stored is `sentAt`, for showing when it was sent.
 *
 * Hidden rows are dropped, with one exception: in a thread (`sender` given),
 * the sender bot's questions arrive as hidden user rows `@<sender>: <text>`
 * and become its bubbles, prefix stripped.
 */
export function messagesFromHistory(
  rows: HistoryRow[],
  options: { asks?: RoomTurnAsk[]; busy?: boolean; sender?: string } = {}
): Message[] {
  const messages: Message[] = []
  const prefix = options.sender ? `@${options.sender}: ` : null
  // Tool rows carry no arguments; the assistant row that made the call does,
  // as the JSON the model wrote. Parsed, they match live `tool.start` args.
  const callOwners = new Map<string, { name?: string; row: HistoryRow }[]>()
  const callOwnersByOccurrence = new Map<string, HistoryRow>()
  const formatted = new Map<HistoryRow, Message>()
  const dreams = new Set<Message>()
  const rowCounts = new Map<string, number>()
  const reports = new Set(rows.filter(row => row.dream === true).map(row => String(row.row_id)))

  // Rows carry `timestamp` in Unix seconds.
  const sent = (row: HistoryRow) =>
    typeof row.timestamp === 'number' && row.timestamp > 0
      ? { sentAt: toMillis(row.timestamp) }
      : {}

  for (const row of rows) {
    if (row.row_id != null) {
      const id = String(row.row_id)
      rowCounts.set(id, (rowCounts.get(id) ?? 0) + 1)
    }

    if (row.role !== 'assistant' || row.dream === true) {
      continue
    }

    for (const call of Array.isArray(row.tool_calls) ? row.tool_calls : []) {
      const { function: fn, id, occurrence_id } = (call ?? {}) as {
        function?: { name?: unknown }
        id?: unknown
        occurrence_id?: unknown
      }

      const name = typeof fn?.name === 'string' && fn.name ? fn.name : undefined

      if (typeof id === 'string') {
        callOwners.set(id, [...(callOwners.get(id) ?? []), { name, row }])
      }

      if (typeof occurrence_id === 'string' && occurrence_id) {
        callOwnersByOccurrence.set(occurrence_id, row)
      }
    }
  }

  for (const row of rows) {
    let text = typeof row.text === 'string' ? row.text : ''

    if (row.display_kind === 'hidden') {
      if (!(prefix && row.role === 'user' && text.startsWith(prefix))) {
        continue
      }

      text = text.slice(prefix.length)
    }

    if (row.role === 'tool') {
      const toolId = String(row.tool_call_id ?? row.tool_id)
      const rowName = typeof row.name === 'string' && row.name ? row.name : undefined

      const occurrenceId =
        typeof row.occurrence_id === 'string' && row.occurrence_id ? row.occurrence_id : undefined

      const parentId =
        typeof row.parent_tool_call_id === 'string' ? row.parent_tool_call_id : undefined

      const occurrenceOwner = !parentId && occurrenceId ? callOwnersByOccurrence.get(occurrenceId) : undefined
      const declarations = callOwners.get(parentId ?? toolId) ?? []

      const candidates = declarations.filter(
        entry =>
          (!row.turn_id || !entry.row.turn_id || row.turn_id === entry.row.turn_id) &&
          (parentId || !rowName || !entry.name || entry.name === rowName)
      )

      const owner = occurrenceOwner ?? (candidates.length === 1 ? candidates[0]!.row : undefined)

      const declaration =
        !parentId && owner?.tool_calls && Array.isArray(owner.tool_calls)
          ? (occurrenceId
              ? owner.tool_calls.find(call => call?.occurrence_id === occurrenceId)
              : undefined) ??
            owner.tool_calls.find(
              call =>
                call?.id === toolId &&
                (!rowName || !call?.function?.name || call.function.name === rowName)
            )
          : undefined

      const args = declaration?.function?.arguments
      const previous = messages.at(-1)

      const messageId =
        owner?.row_id != null && rowCounts.get(String(owner.row_id)) === 1
          ? String(owner.row_id)
          : undefined

      // Preserve the old presentation for projections with no row identities.
      // Identified or ambiguous calls stay unbound until ownership is proven.
      const target = owner
        ? owner.row_id == null || messageId
          ? formatted.get(owner)
          : undefined
        : !callOwners.has(toolId) &&
            !previous?.fragmentIds &&
            previous?.role === 'assistant' &&
            !dreams.has(previous)
          ? previous
          : undefined

      const rawSectionId =
        typeof row.section_id === 'string' && row.section_id ? row.section_id : undefined

      const call = {
        messageId,
        ...(occurrenceId && { occurrenceId }),
        ...(parentId && { parentToolCallId: parentId }),
        args:
          row.args ??
          ((owner?.row_id == null || messageId) && typeof args === 'string'
            ? parseArguments(args)
            : null),
        durationS: null,
        name: String(row.name ?? 'tool'),
        result: rawSectionId
          ? nestedToolResult({
              ...(row.is_error === true
                ? { error: row.text ?? 'Tool failed' }
                : { result: row.text }),
              section_id: rawSectionId
            })
          : (row.text ?? null),
        // History keeps no tool start times; 0 is "unknown", so no time is shown.
        startedAt: 0,
        status: row.is_error === true ? ('error' as const) : ('ok' as const),
        summary: typeof row.context === 'string' ? row.context : undefined,
        toolId: String(row.tool_id ?? row.tool_call_id ?? row.row_id ?? nextMessageId('t'))
      }

      const clarify =
        call.name === 'clarify' ? clarifyFromHistory(call.toolId, call.args, row) : null

      if (clarify) {
        clarify.messageId = call.messageId
        clarify.turnId = typeof row.turn_id === 'string' ? row.turn_id : undefined
      }

      const card = approvalFromHistory(call, row)

      const calls = [
        call,
        ...(row.nested_calls?.calls ?? []).map(nested => ({
          messageId: call.messageId,
          args: nested.arguments ?? null,
          durationS: nested.durationMs == null ? null : nested.durationMs / 1000,
          name: nested.name,
          parentToolCallId: call.toolId,
          ...(call.occurrenceId && { parentOccurrenceId: call.occurrenceId }),
          result: nestedToolResult(nested),
          startedAt: 0,
          status: nested.status === 'error' ? ('error' as const) : ('ok' as const),
          toolId: nested.id
        }))
      ]

      if (target && target.role === 'assistant') {
        target.toolCalls.push(...calls)

        if (clarify) {
          target.clarifies = [...(target.clarifies ?? []), clarify]
        }

        if (card) {
          target.approvals = [...(target.approvals ?? []), card]
        }
      } else {
        messages.push({
          approvals: card ? [card] : undefined,
          attachments: [],
          clarifies: clarify ? [clarify] : undefined,
          createdAt: 0,
          id: String(row.row_id ?? nextMessageId()),
          ...sent(row),
          ...(typeof row.turn_id === 'string' && { turnId: row.turn_id }),
          role: 'assistant',
          streaming: false,
          text: '',
          toolCalls: calls
        })
      }

      continue
    }

    const role: Message['role'] =
      row.role === 'user' || row.role === 'assistant' || row.role === 'system'
        ? row.role
        : 'assistant'

    const previous = messages.at(-1)

    // Hexbot stores one turn as assistant(tool calls) → tool rows → assistant(text).
    // That is one turn with one work line; each message is its own bubble.
    // A question or a card ends the message, as it does live, so it sits between.
    if (
      role === 'assistant' &&
      row.dream !== true &&
      previous?.role === 'assistant' &&
      !dreams.has(previous) &&
      !reports.has(previous.id) &&
      previous.turnId === (typeof row.turn_id === 'string' ? row.turn_id : undefined) &&
      previous.toolCalls.length &&
      !previous.clarifies?.length &&
      !previous.approvals?.length
    ) {
      if (previous.text.trim()) {
        previous.parts = [...(previous.parts ?? []), previous.text]
        previous.partIds = [...(previous.partIds ?? []), previous.textId]
      }

      previous.text = text
      previous.textId = row.row_id == null ? undefined : String(row.row_id)
      // The reply was sent when it ended, not when its first step began.
      Object.assign(previous, sent(row))
      previous.fragmentIds = [
        ...(previous.fragmentIds ?? []),
        ...(previous.textId ? [previous.textId] : [])
      ]
      formatted.set(row, previous)

      continue
    }

    // The files you sent are named under your words; each shows as it did live.
    const attached = role === 'user' ? splitAttached(text) : { files: [], text }

    const message: Message = {
      attachments: attached.files.map(file => ({ id: file.path, ...file })),
      createdAt: 0,
      id: String(row.row_id ?? nextMessageId()),
      ...sent(row),
      ...(typeof row.input_id === 'string' && { inputId: row.input_id }),
      ...(typeof row.turn_id === 'string' && { turnId: row.turn_id }),
      ...(role === 'assistant' &&
        row.row_id != null && {
          fragmentIds: [String(row.row_id)],
          textId: String(row.row_id)
        }),
      role,
      streaming: false,
      text: attached.text,
      toolCalls: []
    }

    messages.push(message)
    formatted.set(row, message)

    if (row.dream === true) {
      dreams.add(message)
    }
  }

  // When a section opens mid-call (`busy: true`), restore any unmatched `message_bot`
  // declarations from the latest exchange as running tool calls so the UI shows
  // "Messaging <Bot>" immediately without waiting for `tool.complete`.
  if (options.busy) {
    const isBoundary = (row: HistoryRow) => {
      const text = typeof row.text === 'string' ? row.text : ''

      if (row.display_kind === 'hidden') {
        return Boolean(prefix && row.role === 'user' && text.startsWith(prefix))
      }

      return row.role === 'user'
    }

    let maxExchange = 0

    for (const row of rows) {
      if (isBoundary(row)) {
        maxExchange += 1
      }
    }

    interface PendingDecl {
      args: Record<string, unknown> | null
      expectedSent: boolean | null
      id: string
      messageId?: string
      occurrenceId?: string
      row: HistoryRow
      target: null | string
      text?: string
      turnId?: string
    }

    const declarations: PendingDecl[] = []

    const results: {
      expectedSent: boolean | null
      id: string
      messageId?: string
      occurrenceId?: string
      sent: boolean
      status: 'error' | 'ok'
      target: null | string
      text?: string
      turnId?: string
    }[] = []

    const persistedNested: {
      call: AskCall
      id: string
      parentOccurrenceId?: string
      parentToolCallId: string
      turnId?: string
    }[] = []

    let exchange = 0
    let latestTurnId: string | undefined

    for (const row of rows) {
      if (isBoundary(row)) {
        exchange += 1

        continue
      }

      if (exchange !== maxExchange || row.display_kind === 'hidden' || row.dream === true) {
        continue
      }

      const rowTurnId = typeof row.turn_id === 'string' ? row.turn_id : undefined

      if (row.role === 'assistant') {
        if (rowTurnId) {
          latestTurnId = rowTurnId
        }

        const messageId =
          row.row_id != null && rowCounts.get(String(row.row_id)) === 1
            ? String(row.row_id)
            : undefined

        for (const call of Array.isArray(row.tool_calls) ? row.tool_calls : []) {
          const entry = (call ?? {}) as {
            function?: { arguments?: unknown; name?: unknown }
            id?: unknown
            occurrence_id?: unknown
          }

          if (typeof entry.id !== 'string' || !entry.id) {
            continue
          }

          const rawArgs = entry.function?.arguments

          const parsedRaw =
            typeof rawArgs === 'string'
              ? parseArguments(rawArgs)
              : rawArgs && typeof rawArgs === 'object'
                ? rawArgs
                : null

          const parsed =
            parsedRaw && typeof parsedRaw === 'object'
              ? (parsedRaw as Record<string, unknown>)
              : null

          const fnName = typeof entry.function?.name === 'string' ? entry.function.name : undefined
          const target = typeof parsed?.to === 'string' && parsed.to ? parsed.to : null
          const isAsk = fnName === 'message_bot' || (!fnName && Boolean(target))

          if (!isAsk) {
            continue
          }

          declarations.push({
            args: parsed,
            expectedSent: askExpectedSent(parsed),
            id: entry.id,
            messageId,
            ...(typeof entry.occurrence_id === 'string' && entry.occurrence_id
              ? { occurrenceId: entry.occurrence_id }
              : {}),
            row,
            target,
            ...(typeof parsed?.text === 'string' ? { text: parsed.text } : {}),
            turnId: rowTurnId
          })
        }
      } else if (
        row.role === 'tool' &&
        (row.name === 'message_bot' ||
          (row as { tool_name?: unknown }).tool_name === 'message_bot')
      ) {
        const id = String(row.tool_call_id ?? row.tool_id ?? '')

        const explicitRow =
          typeof (row as { message_id?: unknown }).message_id === 'string'
            ? String((row as { message_id?: unknown }).message_id)
            : undefined

        const rawResArgs =
          typeof row.args === 'string'
            ? parseArguments(row.args)
            : row.args && typeof row.args === 'object'
              ? row.args
              : null

        const resArgs =
          rawResArgs && typeof rawResArgs === 'object'
            ? (rawResArgs as Record<string, unknown>)
            : null

        const rawTarget =
          (typeof resArgs?.to === 'string' && resArgs.to ? resArgs.to : '') ||
          (typeof row.context === 'string' ? row.context : '')

        const resStatus: 'error' | 'ok' = row.is_error ? 'error' : 'ok'

        const parsedAsk = asksOf([
          {
            args: resArgs,
            name: 'message_bot',
            result: row.text ?? row.content,
            status: resStatus,
            summary: typeof row.context === 'string' ? row.context : undefined
          }
        ])[0]

        results.push({
          expectedSent: askExpectedSent(resArgs),
          id,
          messageId: explicitRow,
          ...(typeof row.occurrence_id === 'string' && row.occurrence_id
            ? { occurrenceId: row.occurrence_id }
            : {}),
          sent: parsedAsk?.sent ?? false,
          status: resStatus,
          target: rawTarget || null,
          ...(typeof resArgs?.text === 'string' ? { text: resArgs.text } : {}),
          turnId: rowTurnId
        })
      } else if (row.role === 'tool' && Array.isArray(row.nested_calls?.calls)) {
        const parentId = String(row.tool_call_id ?? row.tool_id ?? '')

        const parentOccurrenceId =
          typeof row.occurrence_id === 'string' && row.occurrence_id ? row.occurrence_id : undefined

        for (const nested of row.nested_calls.calls) {
          if (nested.name === 'message_bot' && nested.id) {
            persistedNested.push({
              call: {
                args: nested.arguments ?? null,
                name: 'message_bot',
                result: nestedToolResult(nested),
                status: nested.status === 'error' ? 'error' : 'ok'
              },
              id: nested.id,
              ...(parentOccurrenceId ? { parentOccurrenceId } : {}),
              parentToolCallId: parentId,
              turnId: rowTurnId
            })
          }
        }
      }
    }

    const activeDeclarations = latestTurnId
      ? declarations.filter(decl => !decl.turnId || decl.turnId === latestTurnId)
      : declarations

    const matched = new Set<number>()

    for (const res of results) {
      const idx = activeDeclarations.findIndex((decl, i) => {
        if (matched.has(i) || decl.id !== res.id) {
          return false
        }

        if (res.occurrenceId && decl.occurrenceId) {
          return res.occurrenceId === decl.occurrenceId
        }

        if (res.turnId && decl.turnId && res.turnId !== decl.turnId) {
          return false
        }

        if (res.messageId && decl.messageId && res.messageId !== decl.messageId) {
          return false
        }

        if (res.target && decl.target && res.target !== decl.target) {
          return false
        }

        if (res.text !== undefined && decl.text !== undefined && res.text !== decl.text) {
          return false
        }

        if (
          res.expectedSent !== null &&
          decl.expectedSent !== null &&
          res.expectedSent !== decl.expectedSent
        ) {
          return false
        }

        if (res.status === 'ok' && decl.expectedSent !== null && decl.expectedSent !== res.sent) {
          return false
        }

        return true
      })

      if (idx >= 0) {
        matched.add(idx)
      }
    }

    const liveAsks = options.asks ?? []
    const usedLiveAsks = new Set<number>()

    const liveAskMeta = (ask: RoomTurnAsk) => {
      const rawArgs = typeof ask.args === 'string' ? parseArguments(ask.args) : ask.args

      const parsedArgs =
        rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : null

      const text = typeof parsedArgs?.text === 'string' ? parsedArgs.text : undefined

      return {
        expectedSent: askExpectedSent(parsedArgs),
        target: askTarget({
          args: parsedArgs,
          name: 'message_bot',
          status: ask.status,
          summary: ask.context
        }),
        text
      }
    }

    const matchLiveAsk = (entry: {
      expectedSent: boolean | null
      id: string
      messageId?: string
      occurrenceId?: string
      sent?: boolean
      status?: 'error' | 'ok'
      target: null | string
      text?: string
      turnId?: string
    }): RoomTurnAsk | undefined => {
      const askIdx = liveAsks.findIndex((ask, idx) => {
        if (usedLiveAsks.has(idx) || ask.tool_id !== entry.id || ask.parent_tool_call_id) {
          return false
        }

        if (entry.status) {
          if (ask.status !== entry.status) {
            return false
          }

          if (entry.status === 'ok' && entry.sent !== undefined) {
            const liveAskSummary = asksOf([
              {
                args: ask.args,
                name: 'message_bot',
                result: ask.result ?? (ask.section_id ? { section_id: ask.section_id } : null),
                status: ask.status,
                summary: ask.context
              }
            ])[0]

            if (liveAskSummary && liveAskSummary.sent !== entry.sent) {
              return false
            }
          }
        }

        if (ask.occurrence_id && entry.occurrenceId) {
          return ask.occurrence_id === entry.occurrenceId
        }

        if (ask.turn_id && entry.turnId && ask.turn_id !== entry.turnId) {
          return false
        }

        if (ask.message_id && entry.messageId && ask.message_id !== entry.messageId) {
          return false
        }

        const meta = liveAskMeta(ask)

        if (meta.target && entry.target && meta.target !== entry.target) {
          return false
        }

        if (meta.text !== undefined && entry.text !== undefined && meta.text !== entry.text) {
          return false
        }

        if (
          meta.expectedSent !== null &&
          entry.expectedSent !== null &&
          meta.expectedSent !== entry.expectedSent
        ) {
          return false
        }

        return true
      })

      if (askIdx < 0) {
        return undefined
      }

      usedLiveAsks.add(askIdx)

      return liveAsks[askIdx]
    }

    // Consume live snapshot asks already represented by persisted tool results.
    for (const res of results) {
      matchLiveAsk(res)
    }

    for (let i = 0; i < activeDeclarations.length; i++) {
      if (matched.has(i)) {
        continue
      }

      const decl = activeDeclarations[i]!
      const targetMessage = formatted.get(decl.row)

      if (!targetMessage) {
        continue
      }

      const liveAsk = matchLiveAsk(decl)
      const messageId = decl.messageId ?? liveAsk?.message_id
      const occurrenceId = decl.occurrenceId ?? liveAsk?.occurrence_id

      targetMessage.toolCalls.push({
        ...(messageId ? { messageId } : {}),
        ...(occurrenceId ? { occurrenceId } : {}),
        args: decl.args ?? liveAsk?.args ?? null,
        durationS: null,
        name: 'message_bot',
        result: liveAsk
          ? (liveAsk.result ?? (liveAsk.section_id ? { section_id: liveAsk.section_id } : null))
          : null,
        startedAt: 0,
        status: liveAsk ? liveAsk.status : 'running',
        ...(liveAsk?.context ? { summary: liveAsk.context } : {}),
        toolId: decl.id
      })
    }

    // Consume live snapshot asks already represented by persisted nested tool calls.
    for (const nested of persistedNested) {
      const askIdx = liveAsks.findIndex((ask, idx) => {
        if (
          usedLiveAsks.has(idx) ||
          ask.status !== nested.call.status ||
          ask.parent_tool_call_id !== nested.parentToolCallId ||
          (ask.parent_occurrence_id &&
            nested.parentOccurrenceId &&
            ask.parent_occurrence_id !== nested.parentOccurrenceId) ||
          ask.tool_id !== nested.id ||
          (ask.turn_id && nested.turnId && ask.turn_id !== nested.turnId)
        ) {
          return false
        }

        return asksCompatible(nested.call, {
          args: typeof ask.args === 'string' ? parseArguments(ask.args) : ask.args,
          name: 'message_bot',
          ...(ask.occurrence_id ? { occurrenceId: ask.occurrence_id } : {}),
          result: ask.result ?? (ask.section_id ? { section_id: ask.section_id } : null),
          status: ask.status,
          summary: ask.context
        })
      })

      if (askIdx >= 0) {
        usedLiveAsks.add(askIdx)
      }
    }

    // Restore live nested (e.g. codemode) asks and direct asks whose rows have not landed in
    // persisted history yet (e.g. started or settled between reading history and sampling asks).
    const lastUserMessageIndex = messages.findLastIndex(message => message.role === 'user')
    const trailingMessages = messages.slice(lastUserMessageIndex + 1)
    let fallbackAssistant = trailingMessages.findLast(message => message.role === 'assistant')

    for (let idx = 0; idx < liveAsks.length; idx++) {
      if (usedLiveAsks.has(idx)) {
        continue
      }

      const ask = liveAsks[idx]!

      const compatibleFallback =
        fallbackAssistant &&
        (!ask.turn_id || !fallbackAssistant.turnId || fallbackAssistant.turnId === ask.turn_id)
          ? fallbackAssistant
          : undefined

      let ownerMessage =
        (ask.message_id
          ? trailingMessages.findLast(
              message =>
                message.role === 'assistant' && message.fragmentIds?.includes(ask.message_id!)
            )
          : undefined) ??
        (ask.turn_id
          ? trailingMessages.findLast(
              message => message.role === 'assistant' && message.turnId === ask.turn_id
            )
          : undefined) ??
        compatibleFallback

      if (!ownerMessage) {
        ownerMessage = {
          attachments: [],
          createdAt: 0,
          ...(ask.message_id && { fragmentIds: [ask.message_id] }),
          id: ask.message_id ?? nextMessageId('a'),
          role: 'assistant',
          streaming: false,
          text: '',
          toolCalls: [],
          ...(ask.turn_id && { turnId: ask.turn_id })
        }
        messages.push(ownerMessage)
        trailingMessages.push(ownerMessage)
        fallbackAssistant = ownerMessage
      }

      ownerMessage.toolCalls.push({
        ...(ask.message_id ? { messageId: ask.message_id } : {}),
        ...(ask.occurrence_id ? { occurrenceId: ask.occurrence_id } : {}),
        ...(ask.parent_occurrence_id ? { parentOccurrenceId: ask.parent_occurrence_id } : {}),
        ...(ask.parent_tool_call_id ? { parentToolCallId: ask.parent_tool_call_id } : {}),
        args: ask.args ?? null,
        durationS: null,
        name: 'message_bot',
        result: ask.result ?? (ask.section_id ? { section_id: ask.section_id } : null),
        startedAt: 0,
        status: ask.status,
        ...(ask.context ? { summary: ask.context } : {}),
        toolId: ask.tool_id
      })
    }
  }

  return messages
}
