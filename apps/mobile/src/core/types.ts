// Reuse the daemon's wire contract without bundling the web app.
export type {
  Bot,
  Section,
  Room,
  RoomEvent,
  DaemonInfo,
  Settings,
  Device,
  Provider,
  ModelOption,
  Connector,
  SkillInfo,
  NetworkInfo,
  UsageSummary
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
  args: unknown
  detail: string
  status: 'running' | 'ok' | 'error'
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
  attachments?: { name: string; uri?: string }[]
}
export interface PendingApproval {
  requestId: string
  sessionId: string
  command: string
  reason?: string
  choices: string[]
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
  tools: ChatTool[]
  approvals: PendingApproval[]
  questions: PendingQuestion[]
  error: string | null
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
}
export type Rpc = <T = Record<string, unknown>>(
  method: string,
  params?: Record<string, unknown>
) => Promise<T>
