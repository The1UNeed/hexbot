// Reuse the daemon's wire contract without bundling the web app.
export type {
  Bot,
  DiscordMode,
  Reaction,
  ReactionsChanged,
  Section,
  Room,
  RoomEvent,
  RoomTurn,
  RoomTurnAsk,
  DaemonInfo,
  Settings,
  Device,
  Provider,
  ModelOption,
  Connector,
  PasswordLogin,
  Plugin,
  PluginsList,
  SignInForm,
  EmailDraftForm,
  SkillInfo,
  SkillRequirement,
  NetworkInfo,
  UsageSummary,
  Computer,
  ComputerCursor,
  ComputerQuality,
  ComputerSize,
  ComputerStatus
} from '../../../web/src/lib/types'
import type { CurrentUser as WireUser } from '../../../web/src/lib/types'
export type CurrentUser = Omit<WireUser, 'role'>
export interface SavedDaemon {
  id: string
  name: string
  origin: string
  kind: 'local' | 'connect'
  deviceId: string
}
export interface Credential {
  token: string
}
export interface ConnectDaemon {
  id: string
  name?: string
  daemon_name?: string
  address?: string
  tunnel_hostname: string
  identity_key: string | null
  status?: 'online' | 'offline' | 'unreachable'
  online: boolean
}
export interface ChatTool {
  id: string
  name: string
  /** What the step does, as the daemon names it: a `computer_use` action such as `click`. */
  action?: string
  args: unknown
  detail: string
  status: 'running' | 'ok' | 'error' | 'unresolved'
  /** Live: how many of the turn's messages came before it, so it stays under its words. */
  after?: number
  /** Live: the history row of the message that called it. */
  row?: string
  /** Stable per-call occurrence identifier shared by events, snapshots, and history. */
  occurrenceId?: string
  /** Enclosing tool call ID when invoked inside another tool such as `codemode`. */
  parentToolCallId?: string
  /** Occurrence ID of the enclosing parent tool call, distinguishing reused parent call IDs. */
  parentOccurrenceId?: string
  /** The turn that made this tool call, when the daemon names it. */
  turnId?: string
  /** Untagged fresh exchange: how many history messages existed before this exchange started. */
  afterHistoryCount?: number
  /** Unique client sequence for an untagged fresh exchange so multiple buffered completions stay distinct. */
  freshExchange?: number
  /** Busy snapshot placeholder restored before a live `tool.start` arrived. */
  hydrated?: boolean
  /** True once this call has matched a live or replayed `tool.start` in this session. */
  liveStarted?: boolean
  /** True once this call has matched a live or replayed `tool.complete` in this session. */
  liveCompleted?: boolean
  /** Error detail absorbed by an untagged settled ask while an identical sibling was still running. */
  absorbedError?: string
  /** Outcome counts from ambiguous colliding completions while multiple sibling calls ran. */
  ambiguousOutcomes?: { error?: string; failed: number; ok: number }
}
export interface ChatMessage {
  id: string
  /** `system` is a notice in the transcript, such as a failed room turn. */
  role: 'user' | 'assistant' | 'system'
  text: string
  /** The bot or person who spoke, by id; rooms use it for the face and name. */
  sender?: string
  /** A person's name when they are not you, from the room's member list. */
  senderName?: string
  tone?: 'danger' | 'neutral'
  streaming?: boolean
  createdAt?: number
  tools?: ChatTool[]
  attachments?: {
    name: string
    kind?: import('../../../web/src/lib/media').MediaKind
    uri?: string | null
    path?: string
  }[]
  /** The key your message was sent with, which names it for Recall. */
  inputId?: string
  /** The history row the message is, once known; a reaction names it. */
  rowId?: string
  /** The turn this message belongs to, when the daemon names it. */
  turnId?: string
}
export interface PendingApproval {
  requestId: string
  sessionId: string
  command: string
  reason?: string
  choices: string[]
  /** Set once answered, here or on another app; the card stays until the turn ends. */
  decision?: 'deny' | 'once' | 'session'
  /** The tool call that showed the card, when the daemon names it. */
  toolId?: string
  /** The user agreed, but what the card was for didn't work. */
  failed?: boolean
  /** What a draft card did once the mailbox took it, and the email as it went. */
  outcome?: import('../../../web/src/lib/types').EmailDraftAnswer
  /** The sign-in card a bot shows to save a password, a plugin card, or a draft card. */
  form?:
    | import('../../../web/src/lib/types').EmailDraftForm
    | import('../../../web/src/lib/types').PluginForm
    | import('../../../web/src/lib/types').SignInForm
}
export interface PendingQuestion {
  requestId: string
  sessionId: string
  questions: { id: string; text: string; choices: string[]; multiSelect: boolean }[]
}
/** What one live session is doing right now; it empties when the turn ends. */
export interface TurnState {
  streaming: string
  interim: string[]
  busy: boolean
  activity: string
  /** "Checking this step" while Auto mode reviews a step; shown over `activity`. */
  checking: string
  tools: ChatTool[]
  approvals: PendingApproval[]
  questions: PendingQuestion[]
  error: string | null
  /** The history row of the text being written, when the daemon names it. */
  streamId?: string
  /** The history row of each entry in `interim`, in step with it. */
  interimIds?: (string | undefined)[]
  /** The running turn's identifier, when the daemon names it. */
  turnId?: string
  /** True when the running turn began with a fresh `message.start` after the loaded snapshot. */
  startedFresh?: boolean
  /** Unique client sequence for the running untagged fresh exchange. */
  freshExchange?: number
}
/** A bot's turn in a room, kept apart so bots working at once do not mix. */
export interface RoomTurnState extends TurnState {
  bot: string
  sessionId: string
  /** Room-turn row identifier (`room_turns.id`), stable across fallback continuations. */
  roomTurnId?: string
  /** Every `message_bot` call made during this room turn, kept across `message.complete`. */
  asked?: ChatTool[]
  /** True after `message.complete` ended the prior run on this live session. */
  completed?: boolean
  /** True when restored from a running room-turn snapshot before live replay ran. */
  fromSnapshot?: boolean
  /** True when the turn finished silently (`(pass)` or empty text) and no `message.bot` will follow. */
  silent?: boolean
}
export interface ChatState extends TurnState {
  messages: ChatMessage[]
  /** Room turns in flight by live session id. A section keeps its own turn in the top-level fields. */
  turns: Record<string, RoomTurnState>
  /**
   * Asks from a room bot's just-finished turn, held until its durable `message.bot` arrives so
   * the ask pill and face never vanish or remount across the wire gap.
   */
  completingAsks?: Record<string, ChatTool[]>
  /**
   * How many messages the chat had when the running turn started. Its reply
   * goes there, ahead of a message you sent since, which cut it off.
   */
  turnAt?: number
}
export type Rpc = <T = Record<string, unknown>>(
  method: string,
  params?: Record<string, unknown>
) => Promise<T>
