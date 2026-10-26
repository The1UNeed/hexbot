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

/** `always` comes only from daemons before Always allow was removed. */
export type ApprovalChoice = 'always' | 'deny' | 'once' | 'session'

export type ApprovalMode = 'manual' | 'off' | 'smart'

/** One question a bot asks through the clarify tool. */
export interface ClarifyQuestion {
  choices: string[]
  multiSelect: boolean
  question: string
  /** Set for questions that arrived as one batch. */
  questionId?: string
}

/** Wire shape of `clarify.request`: one question, or a batch under `questions`. */
export interface ClarifyRequestPayload {
  message_id?: string
  turn_id?: string
  choices?: null | string[]
  multi_select?: boolean
  question?: string
  questions?: { choices?: null | string[]; multi_select?: boolean; qid: string; question: string }[]
  request_id?: string
}

export interface ClarifyRequest {
  messageId?: string
  turnId?: string
  /** Per question id (single questions use the request id) once answered. */
  answers: Record<string, string>
  /** The gateway stopped waiting; the card stays but no longer takes input. */
  expired?: boolean
  questions: ClarifyQuestion[]
  receivedAt: number
  requestId: string
  sessionId: string
}

export interface ApprovalRequest {
  messageId?: string
  turnId?: string
  choices: ApprovalChoice[]
  /** Present once the user answered; the card stays in the transcript. */
  decision?: ApprovalChoice
  /** The command or action, rendered in monospace. */
  command?: string
  reason?: string
  receivedAt: number
  requestId: string
  sessionId: string
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

export type BotApprovalMode = 'inherit' | ApprovalMode

export type BotStatus = 'idle' | 'needs_you' | 'stopped' | 'working'

export interface BotStatusDetail {
  action: null | { kind: 'fix_connector'; connector: string } | { kind: 'retry' }
  room_id: null | string
  section_id: null | string
  session_id: null | string
  /** Epoch seconds. */
  since: number
  text: string
}

export interface Bot {
  /** Per-bot override; `inherit` follows the deployment setting. */
  approval_mode?: BotApprovalMode
  avatar: Avatar | null
  /** The face picked in an app, drawn live instead of `avatar`; older daemons leave it out. */
  face?: BotFace | null
  created_at: null | number
  description: string
  display_name: string
  last_activity_at: null | number
  model: null | string
  dream_enabled: boolean
  /** Native notifications when the bot stops or needs the user. */
  notify?: boolean
  name: string
  owner_id: string
  persona: string
  /** The one bot that looks after the others; it can't be deleted. Older daemons leave it out. */
  primary?: boolean
  provider: null | string
  /** How hard the model thinks; null means Pi's default, medium. */
  reasoning_effort?: null | ReasoningEffort
  sections_recent: Section[]
  sections_total: number
  skills: string[]
  status?: BotStatus
  status_detail?: BotStatusDetail | null
  title: string
  tools: string[]
  /** Tools set up on the daemon's computer; older daemons leave it out. */
  available_tools?: BotTool[]
  updated_at: null | number
  /** Per-bot working directory; null means the deployment workspace. */
  workdir?: null | string
}

/** The bots' computer, one Cua sandbox per daemon (docs/api.md, "Computer"). */
export type ComputerState =
  'absent' | 'error' | 'resetting' | 'restarting' | 'running' | 'starting' | 'stopped' | 'stopping'

export type ComputerSize = 'large' | 'medium' | 'small'

/** Where a bot last acted, as fractions of the screen, and when. */
export interface ComputerCursor {
  action: string
  /** Seconds since the epoch. */
  at: number
  bot: string
  x: number
  y: number
}

export interface ComputerStatus {
  /** The action in progress, such as `click`, and the bot doing it. */
  activity: null | string
  actor: null | string
  /** Whether the daemon's computer has Cua; events leave it out. */
  available?: boolean
  /** Who is using the computer: the bots, or the user who took over. */
  control: 'bot' | 'user'
  cursors: ComputerCursor[]
  error: null | string
  image?: string
  size?: ComputerSize
  sizes?: { cpu: number; memory_gb: number; name: ComputerSize }[]
  state: ComputerState
}

/** Pi's thinking levels; Pi clamps each to what the model supports. */
export type ReasoningEffort = 'high' | 'low' | 'max' | 'medium' | 'minimal' | 'off' | 'xhigh'

/** Keys of `Bot.tools`; each maps to one Hexbot toolset on the daemon. */
export type BotTool =
  | 'browser'
  | 'code_execution'
  | 'computer_use'
  | 'delegate'
  | 'files'
  | 'message_bots'
  | 'scheduling'
  | 'terminal'
  | 'vision'
  | 'voice'

/** A generated face's shape and colour ids (`lib/avatar-builder.ts`). */
export interface BotFace {
  color: string
  shape: string
}

export interface BotCreateInput {
  avatar?: string
  face?: BotFace | null
  description?: string
  display_name?: string
  model: string
  name: string
  persona?: string
  provider: string
  reasoning_effort?: null | ReasoningEffort
  skills?: string[]
  title?: string
  tools?: string[]
}

export type BotUpdatePatch = Partial<Omit<BotCreateInput, 'avatar' | 'name'>> & {
  approval_mode?: BotApprovalMode
  avatar?: null | string
  dream_enabled?: boolean
  notify?: boolean
  workdir?: null | string
}

export type ConnectorGroup = 'mcp' | 'media' | 'search' | 'social_home' | 'work'

export type ConnectorState = 'error' | 'not_set_up' | 'ready'

export interface ConnectorField {
  advanced: boolean
  help: string
  /** Masked tail of the stored value, like "…4f2a". */
  hint: null | string
  key: string
  label: string
  /** Provider this field belongs to; null when every provider needs it. */
  provider?: null | string
  secret: boolean
  set: boolean
  url: null | string
}

export interface ConnectorProviderOption {
  configured: boolean
  id: string
  label: string
}

/** One row of the connector catalog, with daemon and per-bot state. */
export interface Connector {
  description: string
  enabled_bots: string[]
  /** Null when the list was fetched without a bot. */
  enabled_for_bot: boolean | null
  fields: ConnectorField[]
  group: ConnectorGroup
  /** A Simple Icons slug, or `glyph:<name>` for a neutral icon. */
  icon: string
  id: string
  last_error: null | { at: number; text: string }
  mcp?: {
    /** The server name in its tools' names (`mcp__<name>__<tool>`); may contain underscores. */
    name?: string
    running: boolean
    test_failed?: boolean
    tool_count: number | null
    transport: 'http' | 'sse' | 'stdio'
  }
  name: string
  provider?: null | string
  providers?: ConnectorProviderOption[]
  scope: 'bot' | 'daemon'
  state: ConnectorState
  state_text: string
}

export interface ConnectorTest {
  message: string
  ok: boolean
}

export interface SkillInfo {
  category: string
  description: string
  enabled: boolean
  name: string
}

export type ConnectionStatus =
  'connected' | 'connecting' | 'idle' | 'offline' | 'reconnecting' | 'unauthorized'

export type ConnectionTarget =
  | { deviceToken: string; host: string; kind: 'remote'; port: number; tls: boolean }
  | { kind: 'local'; origin?: string }

export interface DaemonInfo {
  addresses: string[]
  auth_required: boolean | null
  daemon_name: string
  hermes_version: null | string
  home: string
  install_id: null | string
  lan_enabled: boolean
  platform: string
  /** The OS sandbox for shell and code tools, null when none; absent on older daemons. */
  sandbox?: 'bubblewrap' | 'sandbox-exec' | null
  /** `sandbox` once the daemon has sandboxed approvals; absent on older daemons. */
  approvals?: 'sandbox'
  /**
   * True once `hexbot.sections.create` returns the bot's one chat; an older
   * daemon makes a new section every time.
   */
  one_chat?: true
  /** Input, run and assistant fragment correlation metadata; absent on older daemons. */
  transcript_identity?: boolean
  /** How the daemon can update itself when asked; absent on older daemons. */
  update_capability?: 'desktop' | 'service' | null
  version: string
}

/** `hexbot.update.status` (docs/api.md, "Updates"). */
export interface DaemonUpdateStatus {
  at: null | string
  capability: 'desktop' | 'service' | null
  message: null | string
  percent: null | number
  requested: null | string
  status:
    | 'checking'
    | 'downloading'
    | 'failed'
    | 'idle'
    | 'installing'
    | 'requested'
    | 'restarting'
    | 'up-to-date'
  version: null | string
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
  /** Exact accepted input correlation, never inferred from text or position. */
  inputId?: string
  /** One actual daemon run, including hidden or queued inputs. */
  turnId?: string
  /** Durable assistant fragment IDs represented by this bubble. */
  fragmentIds?: string[]
  /** Source identity of each closed text part and the current text. */
  partIds?: (string | undefined)[]
  textId?: string
  /**
   * The daemon's live status line (`thinking.delta`): a wait notice on a slow
   * provider. Replaced on every event, cleared by an empty one.
   */
  activity?: string
  attachments: Attachment[]
  /**
   * Set while Auto mode checks a step before it runs ("Checking this step",
   * a `checking` status line); an empty `checking` line clears it.
   */
  checking?: string
  /**
   * Questions this message asked, restored from history and already settled.
   * Live questions are cards on the transcript instead.
   */
  clarifies?: ClarifyRequest[]
  createdAt: number
  /** Inline error row attached to this message (`error` event). */
  error?: string
  id: string
  /**
   * What the bot said earlier in the same turn, one entry per message it
   * finished before calling a tool. Each is its own bubble; `text` is the
   * message after the last of them.
   */
  parts?: string[]
  role: MessageRole
  /** Set once `message.complete` arrives with a non-ok status. */
  status?: string
  streaming: boolean
  text: string
  /** The reasoning trace, appended by `reasoning.delta`. */
  thinking?: string
  /** Fragment that produced this reasoning trace, when known. */
  thinkingId?: string
  /** Reasoning retained separately when one bubble folds several source fragments. */
  thinkingByFragment?: Record<string, string>
  toolCalls: ToolCall[]
  usage?: Usage | null
  /** When the last reasoning or tool event landed; with `createdAt` it times the work. */
  workUntil?: number
}

export type MessageRole = 'assistant' | 'system' | 'tool' | 'user'

export interface ModelOption {
  context?: number
  id: string
  input_cost?: number
  label: string
  output_cost?: number
  provider: null | string
  /** Levels the model accepts, in order; absent when unknown. */
  reasoning_levels?: ReasoningEffort[]
}

export interface NetworkInfo {
  addresses: string[]
  bind_host: string
  lan_enabled: boolean
  port: number
  restarting?: boolean
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
  /** False for providers configured through a local SDK, process, or endpoint config. */
  key_supported?: boolean
  label: string
  models_source: string
}

export interface Section {
  archived_at: null | number
  bot: string
  created_at: null | number
  /** When the bot last finished a turn here that the user has not seen yet. */
  done_at?: null | number
  id: string
  live_session_id: null | string
  message_count: number
  /**
   * Set on a thread: the private conversation in which `peer_bot` asked `bot`
   * for help through `message_bot`. Threads stay out of every section list.
   */
  peer_bot?: null | string
  /**
   * Set on a section with its own job, such as the primary bot's Check-ins
   * (`checkins`). It is never the bot's chat. Older daemons leave it out.
   */
  purpose?: null | string
  preview: string
  title: string
  /** `bot` when the bot named the section itself; null once the user renames it. */
  title_by: 'bot' | null
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
  /** Absent on daemons from before check-ins. */
  checkin_enabled?: boolean
  checkin_every_minutes?: number
  /** `HH:MM-HH:MM` in the daemon's time zone; may run past midnight. */
  checkin_hours?: string
}

export interface CheckinWakeup {
  id: string
  /** RFC 3339. */
  at: string
  /** The daemon's local time, already formatted. */
  local: string
  note: string
}

export interface CheckinRun {
  id: string
  bot: string
  kind: 'heartbeat' | 'manual' | 'wakeup'
  started_at: string
  finished_at: null | string
  status: 'complete' | 'failed' | 'running'
  summary: string
  messaged: boolean
}

export interface CheckinStatus {
  enabled: boolean
  every_minutes: number
  hours: string
  /** The primary bot, which is the one that checks in. */
  bot: null | string
  /** Its Check-ins section, once it has messaged you. */
  section_id: null | string
  running: boolean
  next_run_at: null | string
  wakeups: CheckinWakeup[]
  recent: CheckinRun[]
}

/** The one person a daemon belongs to. */
export interface CurrentUser {
  /** Absent on daemons without display-name editing. */
  can_rename?: boolean
  /** Older daemons may say member; they reject Bypass from members. */
  role?: 'admin' | 'member'
  id: string
  display_name: string
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
  /** The member's display name; older daemons may leave it out. */
  display_name?: null | string
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
  approval_mode: BotApprovalMode | null
  archived_at: null | number
  created_at: number
  id: string
  last_activity_at: number
  limits: RoomLimits
  main_bot: null | string
  members: RoomMember[]
  name: string
  owner_id: string
  /** Bots with a turn running now; older daemons leave it out. */
  turns?: Pick<RoomTurn, 'bot' | 'live_session_id'>[]
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
  /** Cards the running turn still waits on, at this read; older daemons leave it out. */
  pending_requests?: string[]
  room_id: string
  status: string
}

export interface StatusLine {
  kind: string
  text: string
}

export interface ToolCall {
  /** Assistant fragment that issued this call, when the daemon proves it. */
  messageId?: string
  parentToolCallId?: string
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

/**
 * How full a section's context is, from the daemon with `session.usage` and
 * `hexbot.sections.open`. `tokens` is null when no estimate is available or
 * right after a summary; `window` and `compact_at` are null when the model is
 * unknown. The window is never called memory: Memory is the bot's MEMORY.md.
 */
export interface ContextUsage {
  /** Pi summarises above this threshold: window minus reserve, possibly zero or negative. */
  compact_at: null | number
  /** True from a compaction's start until the daemon says it is done. */
  compacting: boolean
  /** True while `tokens` is null because a compaction just ran, until the next reply. */
  recounting?: boolean
  /** Orders reports of one session; a report below the one held is stale. */
  seq?: number
  tokens: null | number
  window: null | number
}
