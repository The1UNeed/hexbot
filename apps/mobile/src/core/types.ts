// Reuse the daemon's wire contract without bundling the web app.
export type {
  Bot,
  DiscordMode,
  Reaction,
  ReactionsChanged,
  Section,
  Room,
  RoomEvent,
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
  status: 'running' | 'ok' | 'error'
  /** Live: how many of the turn's messages came before it, so it stays under its words. */
  after?: number
  /** Live: the history row of the message that called it. */
  row?: string
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
}
/** A bot's turn in a room, kept apart so bots working at once do not mix. */
export interface RoomTurnState extends TurnState {
  bot: string
  sessionId: string
}
export interface ChatState extends TurnState {
  messages: ChatMessage[]
  /** Room turns in flight by live session id. A section keeps its own turn in the top-level fields. */
  turns: Record<string, RoomTurnState>
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
