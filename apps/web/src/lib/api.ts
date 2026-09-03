/**
 * Typed wrappers for every daemon method the client calls: the `hexbot.*`
 * surface from docs/api.md plus the Hermes chat subset from
 * docs/upstream/ws-api.md. Everything goes through the active RPC client, so
 * a call before the connection is up rejects with `NotConnectedError`.
 */

import { rpcCall } from './rpc'
import type {
  ApprovalChoice,
  Bot,
  BotCreateInput,
  BotUpdatePatch,
  CoreMemory,
  CoreMemorySection,
  DaemonInfo,
  Device,
  Message,
  ModelOption,
  NetworkInfo,
  PairingCode,
  Provider,
  Section,
  Settings,
  Usage
} from './types'

/** Raw history row as projected by Hermes `session.history`. */
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
  caps: { memory_md: number; user_md: number }
  memory_md: string
  user_md: string
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

export function botsUpdate(name: string, patch: BotUpdatePatch): Promise<{ bot: Bot }> {
  return rpcCall<{ bot: Bot }>('hexbot.bots.update', { name, ...patch })
}

export function botsDelete(name: string): Promise<{ deleted: boolean }> {
  return rpcCall<{ deleted: boolean }>('hexbot.bots.delete', { name })
}

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

export function sectionsOpen(id: string): Promise<{ messages: HistoryRow[]; section: Section }> {
  return rpcCall<{ messages: HistoryRow[]; section: Section }>('hexbot.sections.open', { id })
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

export function sectionsTouch(id: string): Promise<{ section: Section }> {
  return rpcCall<{ section: Section }>('hexbot.sections.touch', { id })
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export function coreMemoryGet(): Promise<CoreMemory> {
  return rpcCall<CoreMemory>('hexbot.memory.core.get')
}

export function coreMemorySet(section: CoreMemorySection, text: string): Promise<CoreMemory> {
  return rpcCall<CoreMemory>('hexbot.memory.core.set', { section, text })
}

export function botMemoryGet(bot: string): Promise<BotMemory> {
  return rpcCall<BotMemory>('hexbot.memory.bot.get', { bot })
}

export function botMemorySet(
  bot: string,
  patch: { memory_md?: string; user_md?: string }
): Promise<BotMemory> {
  return rpcCall<BotMemory>('hexbot.memory.bot.set', { bot, ...patch })
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

export function modelsList(provider?: string): Promise<ModelList> {
  return rpcCall<ModelList>('hexbot.models.list', provider ? { provider } : {})
}

/** Raw Hermes picker payload; `hexbot.models.list` is the projected form. */
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
// Hermes chat
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

export function sessionSteer(
  sessionId: string,
  text: string
): Promise<{ status: string; text: string }> {
  return rpcCall<{ status: string; text: string }>('session.steer', { session_id: sessionId, text })
}

export function sessionHistory(
  sessionId: string
): Promise<{ count: number; messages: HistoryRow[] }> {
  return rpcCall<{ count: number; messages: HistoryRow[] }>('session.history', {
    session_id: sessionId
  })
}

export function sessionEventsSince(
  sessionId: string,
  lastSeen: number
): Promise<{
  count: number
  epoch?: string
  events: unknown[]
  latest_seq: number
  truncated: boolean
}> {
  return rpcCall('session.events.since', { last_seen: lastSeen, session_id: sessionId })
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

export function gatewayCapabilities(): Promise<Record<string, unknown>> {
  return rpcCall<Record<string, unknown>>('gateway.capabilities')
}

export function gatewayPing(): Promise<{ ok: boolean }> {
  return rpcCall<{ ok: boolean }>('gateway.ping')
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export function approvalPending(sessionId: string): Promise<{ approvals: unknown[] }> {
  return rpcCall<{ approvals: unknown[] }>('approval.pending', { session_id: sessionId })
}

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

export function imageDetach(sessionId: string, index?: number): Promise<AttachResult> {
  return rpcCall<AttachResult>('image.detach', {
    session_id: sessionId,
    ...(index === undefined ? {} : { index })
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

/** Base64 payload without the `data:` prefix. */
export async function readFileAsBase64(file: Blob): Promise<string> {
  const dataUrl = await readFileAsDataUrl(file)

  return base64FromDataUrl(dataUrl)
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
 * Stage one file for the next `prompt.submit`, picking the right Hermes
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
 * Turn the Hermes `session.history` projection into transcript messages.
 * Tool rows fold into the assistant message that precedes them, matching how
 * live `tool.start` / `tool.complete` events are rendered.
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
          createdAt: Date.now(),
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

    messages.push({
      attachments: [],
      createdAt: Date.now(),
      id: String(row.row_id ?? nextMessageId()),
      role,
      streaming: false,
      text: typeof row.text === 'string' ? row.text : '',
      toolCalls: []
    })
  }

  return messages
}
