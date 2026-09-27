/**
 * Typed wrappers for every daemon method the client calls: the `hexbot.*`
 * surface from docs/api.md plus the Hexbot chat subset from
 * docs/core/ws-api.md. Everything goes through the active RPC client, so
 * a call before the connection is up rejects with `NotConnectedError`.
 */

import { rpcCall } from './rpc'
import type {
  ApprovalChoice,
  Bot,
  BotCreateInput,
  BotUpdatePatch,
  ClarifyRequestPayload,
  Connector,
  ConnectorTest,
  DaemonInfo,
  DaemonUpdateStatus,
  Device,
  Message,
  ModelOption,
  NetworkInfo,
  PairingCode,
  Provider,
  ProviderLogin,
  Room,
  RoomEvent,
  RoomLimits,
  Section,
  Settings,
  SkillInfo,
  Usage
} from './types'
import type { CurrentUser, UsageSummary, User } from './types'

/** Raw history row as projected by Hexbot `session.history`. */
export interface HistoryRow {
  args?: unknown
  context?: string
  display_kind?: string
  name?: string
  role: string
  row_id?: string
  text?: string
  [key: string]: unknown
}

export interface BotMemory {
  cap: number
  memory_md: string
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

export function botsCreate(input: BotCreateInput): Promise<{ bot: Bot; section: Section }> {
  return rpcCall<{ bot: Bot; section: Section }>('hexbot.bots.create', { ...input })
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
  return rpcCall<{ bot: Bot }>('hexbot.bots.update', { name, ...patch })
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

export function connectorsSetForBot(
  id: string,
  bot: string,
  enabled: boolean
): Promise<{ connector: Connector }> {
  return rpcCall<{ connector: Connector }>('hexbot.connectors.set_for_bot', { bot, enabled, id })
}

export interface McpServerInput {
  args?: string[]
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

export function roomsRemoveMember(id: string, bot: string): Promise<{ room: Room }> {
  return rpcCall<{ room: Room }>('hexbot.rooms.remove_member', { bot, id })
}

export function roomsSend(
  id: string,
  text: string,
  attachments: unknown[] = []
): Promise<{ event: RoomEvent }> {
  return rpcCall<{ event: RoomEvent }>('hexbot.rooms.send', { attachments, id, text })
}

export function roomsLog(
  id: string,
  options: { after_seq?: number; limit?: number } = {}
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

export interface ConnectStatus {
  registered: boolean
  daemon_id: null | string
  slug: null | string
  tunnel_hostname: null | string
  tunnel_running: boolean
  last_heartbeat_at: null | number
  last_error: null | string
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
export const usersList = () => rpcCall<{ users: User[] }>('hexbot.users.list')
export const usersInvite = (displayName: string, role: 'admin' | 'member' = 'member') =>
  rpcCall<{ user: User; code: string; expires_at: number }>('hexbot.users.invite', {
    display_name: displayName,
    role
  })
export const usersUpdate = (
  id: string,
  patch: Partial<Pick<User, 'display_name' | 'role' | 'disabled' | 'limits'>>
) => rpcCall<{ user: User }>('hexbot.users.update', { id, ...patch })
export const usageSummary = (user?: string) =>
  rpcCall<UsageSummary>('hexbot.usage.summary', user ? { user } : {})

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export function sectionsList(options: { bot?: string; include_archived?: boolean } = {}): Promise<{
  sections: Section[]
}> {
  return rpcCall<{ sections: Section[] }>('hexbot.sections.list', { ...options })
}

export function sectionsCreate(bot: string, title?: string): Promise<{ section: Section }> {
  return rpcCall<{ section: Section }>(
    'hexbot.sections.create',
    title === undefined ? { bot } : { bot, title }
  )
}

export interface SectionOpened {
  messages: HistoryRow[]
  /** A clarify question the bot is still waiting on (same shape as the event, plus locked answers). */
  pending_clarify?: ClarifyRequestPayload & { answers?: Record<string, string> }
  section: Section
}

export function sectionsOpen(id: string): Promise<SectionOpened> {
  return rpcCall<SectionOpened>('hexbot.sections.open', { id })
}

export function sectionsRename(id: string, title: string): Promise<{ section: Section }> {
  return rpcCall<{ section: Section }>('hexbot.sections.rename', { id, title })
}

export function sectionsArchive(id: string): Promise<{ section: Section }> {
  return rpcCall<{ section: Section }>('hexbot.sections.archive', { id })
}

export function sectionsUnarchive(id: string): Promise<{ section: Section }> {
  return rpcCall<{ section: Section }>('hexbot.sections.unarchive', { id })
}

export function sectionsDelete(id: string, purgeMemory = true): Promise<{ deleted: boolean }> {
  return rpcCall<{ deleted: boolean }>('hexbot.sections.delete', { id, purge_memory: purgeMemory })
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
  display_kind?: 'hidden'
  queued?: boolean
  surface?: string
}

export function promptSubmit(
  sessionId: string,
  text: string,
  options: PromptSubmitOptions = {}
): Promise<{ status: string }> {
  return rpcCall<{ status: string }>('prompt.submit', { session_id: sessionId, text, ...options })
}

export function sessionInterrupt(sessionId: string): Promise<{ status: string }> {
  return rpcCall<{ status: string }>('session.interrupt', { session_id: sessionId })
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
  choice: ApprovalChoice
): Promise<{ resolved: boolean }> {
  return rpcCall<{ resolved: boolean }>('approval.respond', {
    choice,
    request_id: requestId,
    session_id: sessionId
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

/**
 * Stage one file for the next `prompt.submit`, picking the right Hexbot
 * method from its type.
 */
export async function attachFile(sessionId: string, file: File): Promise<AttachResult> {
  const kind = attachmentKind(file.type, file.name)
  const dataUrl = await readFileAsDataUrl(file)

  if (kind === 'image') {
    return imageAttachBytes(sessionId, base64FromDataUrl(dataUrl), file.name)
  }

  if (kind === 'pdf') {
    return pdfAttach(sessionId, base64FromDataUrl(dataUrl))
  }

  return fileAttach(sessionId, dataUrl, file.name)
}

// ---------------------------------------------------------------------------
// History projection
// ---------------------------------------------------------------------------

let messageCounter = 0

export function nextMessageId(prefix = 'm'): string {
  messageCounter += 1

  return `${prefix}${messageCounter}-${Date.now().toString(36)}`
}

/**
 * Turn the Hexbot `session.history` projection into transcript messages.
 * Tool rows fold into the assistant message that precedes them, matching how
 * live `tool.start` / `tool.complete` events are rendered.
 */
/**
 * Hexbot history rows carry no timestamps, so restored messages get `createdAt: 0`
 * ("unknown") and the transcript draws no time separator for them.
 */
export function messagesFromHistory(rows: HistoryRow[]): Message[] {
  const messages: Message[] = []

  for (const row of rows) {
    if (row.display_kind === 'hidden') {
      continue
    }

    if (row.role === 'tool') {
      const target = messages.at(-1)

      const call = {
        args: row.args ?? null,
        durationS: null,
        name: String(row.name ?? 'tool'),
        result: row.text ?? null,
        startedAt: Date.now(),
        status: 'ok' as const,
        summary: typeof row.context === 'string' ? row.context : undefined,
        toolId: String(row.row_id ?? nextMessageId('t'))
      }

      if (target && target.role === 'assistant') {
        target.toolCalls.push(call)
      } else {
        messages.push({
          attachments: [],
          createdAt: 0,
          id: nextMessageId(),
          role: 'assistant',
          streaming: false,
          text: '',
          toolCalls: [call]
        })
      }

      continue
    }

    const role: Message['role'] =
      row.role === 'user' || row.role === 'assistant' || row.role === 'system'
        ? row.role
        : 'assistant'

    const text = typeof row.text === 'string' ? row.text : ''
    const previous = messages.at(-1)

    // Hexbot stores one turn as assistant(tool calls) → tool rows → assistant(text).
    // Live streaming shows that as one bubble, so history must too.
    if (role === 'assistant' && previous?.role === 'assistant' && previous.toolCalls.length) {
      previous.text = previous.text ? `${previous.text}\n\n${text}` : text

      continue
    }

    messages.push({
      attachments: [],
      createdAt: 0,
      id: String(row.row_id ?? nextMessageId()),
      role,
      streaming: false,
      text,
      toolCalls: []
    })
  }

  return messages
}
