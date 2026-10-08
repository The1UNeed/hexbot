/**
 * Display types for the screens. They are plain view models: the parent maps
 * daemon wire shapes (core/types) onto them, so screens never touch the
 * network. Times are epoch milliseconds.
 */

import type { BotStatus, FaceSource } from '../ui'

export type { BotStatus, FaceSource } from '../ui'

export interface BotSummary extends FaceSource {
  id: string
  /** The bot's one-line role. */
  title?: string | null
  /** What the bot is for, in the owner's words. */
  description?: string | null
  /** Title of the latest thread, shown with `preview`. */
  latestThread?: string | null
  threadCount?: number | null
  /** What the bot is doing now, such as "Reading 14 sources". */
  activity?: string | null
  /** Last thing said in its latest conversation. */
  preview?: string | null
  updatedAt?: number | null
  status?: BotStatus
}

export interface RoomSummary {
  id: string
  name: string
  /** Bot members, in join order; the first four draw the room's face. */
  members: FaceSource[]
  /** People in the group, you included. */
  people?: number
  preview?: string | null
  updatedAt?: number | null
  status?: BotStatus
  archived?: boolean
}

/** A daemon this app has paired with and can switch to. */
export interface DaemonEntry {
  id: string
  name: string
  /** Host and port, or the Connect hostname. */
  address: string
  via: 'connect' | 'demo' | 'lan'
  current?: boolean
  /** Unknown until the app has tried it. */
  reachable?: boolean | null
  lastUsedAt?: number | null
}

export type ConnectionState =
  'connected' | 'connecting' | 'offline' | 'reconnecting' | 'unauthorized'

/** The daemon the app is connected to now. */
export interface DaemonOverview {
  name: string
  address: string
  via: DaemonEntry['via']
  state: ConnectionState
  version?: string | null
  platform?: string | null
  /** Shown as a line under the name, such as "3 bots working". */
  detail?: string | null
}

/** One thread with a bot. The daemon calls it a section; each is its own Pi session. */
export interface SectionSummary {
  id: string
  title: string
  preview?: string | null
  updatedAt?: number | null
  archived?: boolean
  messageCount?: number | null
  /** The bot is working in this thread now. */
  working?: boolean
  /** The bot finished here and you have not looked yet. */
  unread?: boolean
}

export interface ToolActivity {
  id: string
  /** What the user reads: "Read inbox", "Ran npm test". */
  label: string
  /** The tool's own name, such as `write_file`, for its icon. */
  name?: string
  /** One line of result for the transcript. */
  detail?: string | null
  /** The full call, for the tool's own card. */
  input?: string | null
  output?: string | null
  status: 'error' | 'ok' | 'running'
}

export type ApprovalChoice = 'deny' | 'once' | 'session'

export interface ApprovalRequestView {
  requestId: string
  /** The command or action, shown in monospace. */
  command?: string | null
  reason?: string | null
  toolLabel?: string | null
  choices: ApprovalChoice[]
  /** Set once answered; the card stays and shows the answer. */
  decision?: ApprovalChoice | null
}

export interface AttachmentView {
  id: string
  name: string
  kind: 'file' | 'image'
  uri?: string | null
}

/** One entry in a chat transcript, oldest first. */
export type ChatItem =
  | {
      kind: 'message'
      id: string
      role: 'bot' | 'user'
      text: string
      /** Who spoke, in rooms. Bot sections can leave it out. */
      author?: FaceSource
      createdAt?: number | null
      streaming?: boolean
      error?: string | null
      attachments?: AttachmentView[]
    }
  | { kind: 'tools'; id: string; tools: ToolActivity[] }
  /** A bot's interactive visual, shown as its own card. */
  | { kind: 'visual'; id: string; title: string; index: number }
  | { kind: 'approval'; id: string; request: ApprovalRequestView }
  | { kind: 'notice'; id: string; text: string; tone?: 'danger' | 'neutral' }
  | { kind: 'day'; id: string; at: number }

export interface ModelChoice {
  id: string
  label: string
  provider: string
  detail?: string | null
}

export interface ToolToggle {
  id: string
  label: string
  description?: string | null
  enabled: boolean
  /** False when the tool is not set up on the daemon's computer. */
  available?: boolean
}

export interface DeviceView {
  id: string
  name: string
  platform: string
  lastSeenAt?: number | null
  current?: boolean
}

export interface JobView {
  id: string
  name: string
  /** Plain-language schedule: "Every day at 8:00 AM". */
  schedule: string
  bot?: FaceSource | null
  nextRunAt?: number | null
  lastRunOk?: boolean | null
  enabled: boolean
}

export interface PairingView {
  code: string
  link: string
  expiresAt: number
}
