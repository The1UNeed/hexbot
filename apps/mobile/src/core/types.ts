// Reuse the daemon's wire contract without bundling the web app.
export type {
  Bot,
  Section,
  Room,
  RoomEvent,
  CurrentUser,
  DaemonInfo,
  Settings,
  Device,
  Provider,
  ModelOption,
  Connector,
  SkillInfo,
  NetworkInfo,
  User,
  UsageSummary
} from '../../../web/src/lib/types'
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
  role: 'user' | 'assistant' | 'system'
  text: string
  sender?: string
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
export interface ChatState {
  messages: ChatMessage[]
  streaming: string
  interim: string[]
  busy: boolean
  activity: string
  tools: ChatTool[]
  approvals: PendingApproval[]
  questions: PendingQuestion[]
  error: string | null
}
export type Rpc = <T = Record<string, unknown>>(
  method: string,
  params?: Record<string, unknown>
) => Promise<T>
