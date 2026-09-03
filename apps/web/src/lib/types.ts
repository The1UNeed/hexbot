/**
 * Shared domain types.
 *
 * Wire shapes (`Bot`, `Section`, `DaemonInfo`, `Settings`, `Provider`,
 * `ModelOption`, `Device`, `NetworkInfo`) keep the daemon's snake_case field
 * names from docs/api.md so they can be used straight off the RPC result.
 * Client-side view models (`Message`, `ToolCall`, `Attachment`,
 * `ApprovalRequest`) use camelCase as described in
 * docs/client-architecture.md.
 */

export type ApprovalChoice = 'always' | 'deny' | 'once' | 'session'

export type ApprovalMode = 'manual' | 'off' | 'smart'

export interface ApprovalRequest {
  choices: ApprovalChoice[]
  /** Present once the user answered; the card stays in the transcript. */
  decision?: ApprovalChoice
  /** The command or action, rendered in monospace. */
  command?: string
  reason?: string
  receivedAt: number
  requestId: string
  sessionId: string
  /** Hermes sets this when the auto-approver refused the action. */
  smartDenied?: boolean
  toolName?: string
}

export interface Attachment {
  dataUrl?: string
  id: string
  kind: AttachmentKind
  mime: string
  name: string
  /** Gateway-local path returned by `file.attach`. */
  path?: string
  size: number
}

export type AttachmentKind = 'file' | 'image' | 'pdf'

export interface Avatar {
  data: string
  mime: string
}

export interface Bot {
  avatar: Avatar | null
  created_at: null | number
  description: string
  display_name: string
  last_activity_at: null | number
  model: null | string
  name: string
  owner_id: string
  persona: string
  provider: null | string
  sections_recent: Section[]
  sections_total: number
  title: string
  updated_at: null | number
}

export interface BotCreateInput {
  avatar?: string
  description?: string
  display_name?: string
  model: string
  name: string
  persona?: string
  provider: string
  title?: string
}

export type BotUpdatePatch = Partial<Omit<BotCreateInput, 'name'>> & { avatar?: null | string }

export type ConnectionStatus =
  | 'connected'
  | 'connecting'
  | 'idle'
  | 'offline'
  | 'reconnecting'
  | 'unauthorized'

export type ConnectionTarget =
  | { deviceToken: string; host: string; kind: 'remote'; port: number }
  | { kind: 'local' }

export interface CoreMemory {
  caps: { per_section: number }
  sections: Record<CoreMemorySection, string>
  updated_at: null | number
}

export type CoreMemorySection = 'household' | 'rules' | 'user' | 'workspace'

export interface DaemonInfo {
  addresses: string[]
  auth_required: boolean | null
  daemon_name: string
  hermes_version: null | string
  home: string
  install_id: null | string
  lan_enabled: boolean
  platform: string
  version: string
}

export interface Device {
  created_at: null | number
  current: boolean
  id: string
  last_seen_at: null | number
  name: string
  platform: string
}

export interface Message {
  attachments: Attachment[]
  createdAt: number
  /** Inline error row attached to this message (`error` event). */
  error?: string
  id: string
  role: MessageRole
  /** Set once `message.complete` arrives with a non-ok status. */
  status?: string
  streaming: boolean
  text: string
  /** Collapsed thinking block, filled by `thinking.delta`. */
  thinking?: string
  toolCalls: ToolCall[]
  usage?: Usage | null
}

export type MessageRole = 'assistant' | 'system' | 'tool' | 'user'

export interface ModelOption {
  context?: number
  id: string
  input_cost?: number
  label: string
  output_cost?: number
  provider: null | string
}

export interface NetworkInfo {
  addresses: string[]
  bind_host: string
  lan_enabled: boolean
  port: number
  restart_required?: boolean
}

export interface PairingCode {
  code: string
  expires_at: number
  link: string
}

export interface Provider {
  auth_type: string
  /** `null` means an external OAuth provider whose state is unknown. */
  configured: boolean | null
  id: string
  label: string
  models_source: string
}

export interface Section {
  archived_at: null | number
  bot: string
  created_at: null | number
  id: string
  live_session_id: null | string
  message_count: number
  preview: string
  title: string
  updated_at: null | number
}

export interface SessionInfo {
  branch?: null | string
  cwd?: null | string
  model?: null | string
  profile_name?: null | string
  project?: null | string
  provider?: null | string
  skills?: string[]
  tools?: string[]
}

export interface Settings {
  approval_mode: ApprovalMode
  auto_approver_model: null | string
  billing_notice_ack: boolean
  lan_enabled: boolean
  service_installed: boolean
  workspace_dir: string
}

export interface StatusLine {
  kind: string
  text: string
}

export interface ToolCall {
  args: unknown
  durationS: number | null
  name: string
  result: unknown
  startedAt: number
  status: ToolCallStatus
  summary?: string
  toolId: string
}

export type ToolCallStatus = 'error' | 'ok' | 'running'

export interface Usage {
  cost?: number
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  [key: string]: unknown
}
