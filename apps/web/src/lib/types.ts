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
  dream_enabled: boolean
  may_write_core: boolean
  shareable: boolean
  name: string
  owner_id: string
  persona: string
  provider: null | string
  sections_recent: Section[]
  sections_total: number
  skills: string[]
  title: string
  tools: string[]
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
  skills?: string[]
  title?: string
  tools?: string[]
}

export type BotUpdatePatch = Partial<Omit<BotCreateInput, 'name'>> & {
  avatar?: null | string
  dream_enabled?: boolean
  may_write_core?: boolean
  shareable?: boolean
}

export type ConnectionStatus =
  'connected' | 'connecting' | 'idle' | 'offline' | 'reconnecting' | 'unauthorized'

export type ConnectionTarget =
  | { deviceToken: string; host: string; kind: 'remote'; port: number; tls: boolean }
  | { kind: 'local'; origin?: string }

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

export interface ProviderLogin {
  code: string
  login_id: string
  message: string
  provider: string
  status: 'cancelled' | 'done' | 'error' | 'pending' | 'starting'
  supported?: boolean
  url: string
}

export interface Provider {
  /** `api_key`, or `oauth_*` for a subscription sign-in. */
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
  /** `provider/model` pre-filled for new bots. */
  default_model?: null | string
  /** `provider/model` bots fall back to when their own provider fails. */
  fallback_model?: null | string
  billing_notice_ack: boolean
  lan_enabled: boolean
  bot_daily_token_budget?: null | number
  room_bot_turns_per_human_turn?: number
  room_budget_tokens_per_human_turn?: null | number
  service_installed: boolean
  workspace_dir: string
  dream_enabled: boolean
  dream_time: string
}

export interface CurrentUser {
  id: string
  display_name: string
  role: 'admin' | 'member'
}
export interface User extends CurrentUser {
  created_at?: number
  disabled_at?: null | number
  disabled?: boolean
  limits?: { daily_tokens: null | number }
}
export interface UsageSummary {
  input_tokens: number
  output_tokens: number
  estimated_cost_usd: number
  by_bot:
    | Record<string, { input_tokens: number; output_tokens: number; estimated_cost_usd?: number }>
    | Array<{
        bot: string
        input_tokens: number
        output_tokens: number
        estimated_cost_usd?: number
      }>
}

export interface RoomMember {
  added_at: number
  added_by: string
  last_read_seq: number
  left_at: null | number
  member_id: string
  member_kind: 'bot' | 'human'
  room_id: string
}

export interface RoomLimits {
  bot_daily_token_budget?: null | number
  bot_turns_per_human_turn?: null | number
  budget_tokens_per_human_turn?: null | number
  [key: string]: unknown
}

export interface Room {
  approval_mode: ApprovalMode | null
  archived_at: null | number
  created_at: number
  id: string
  last_activity_at: number
  limits: RoomLimits
  main_bot: null | string
  members: RoomMember[]
  name: string
  owner_id: string
  updated_at: number
}

export type RoomEventKind =
  | 'limit.tripped'
  | 'member.added'
  | 'member.left'
  | 'message.bot'
  | 'message.user'
  | 'note'
  | 'turn.failed'
  | 'turn.started'
  | 'waiting.human'

export interface RoomEvent {
  actor_id: null | string
  actor_kind: null | 'bot' | 'human' | 'system'
  created_at: number
  kind: RoomEventKind
  payload: Record<string, unknown> & { attachments?: unknown[]; bot?: string; text?: string }
  room_id: string
  seq: number
}

export interface RoomTurn {
  bot: string
  live_session_id: null | string
  room_id: string
  status: string
}

export interface ActivityPair {
  count: number
  from_bot: string
  last_at: number
  to_bot: string
}

export interface BotMessage {
  created_at: number
  from_bot: string
  id: string
  room_id: null | string
  section_id: string
  text: string
  to_bot: string
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
