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
  /** What the bot is doing now, such as "Reading 14 sources". */
  activity?: string | null
  /** Something said in its chat, quoted on its card. */
  preview?: string | null
  updatedAt?: number | null
  status?: BotStatus
  /** The primary bot, pinned on top of the list. */
  primary?: boolean
}

/**
 * One row in the chat list: a bot's chat, a room, or the primary bot's
 * Check-ins. `id` is the bot's name, the room's id or the section's id.
 */
export interface ConversationSummary {
  kind: 'bot' | 'checkins' | 'room'
  id: string
  name: string
  /** The bot's face; a room draws `members` instead. */
  face?: FaceSource
  members?: FaceSource[]
  preview?: string | null
  /** What the bot is doing now, shown instead of the preview while it works. */
  activity?: string | null
  updatedAt?: number | null
  status?: BotStatus
  /** The primary bot's chat. */
  primary?: boolean
  /** Pinned: drawn as a large face above the list. The primary bot starts pinned. */
  pinned?: boolean
  /** When it was pinned, epoch milliseconds; pinned faces keep that order. */
  pinnedAt?: number | null
  /** Something finished here that you have not seen. */
  unread?: boolean
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
  /** A sign-in or plugin card: the user types what the bot never sees. A draft card: an email only the user sends. */
  form?:
    | import('../../../web/src/lib/types').EmailDraftForm
    | import('../../../web/src/lib/types').PluginForm
    | import('../../../web/src/lib/types').SignInForm
}

/** What the user typed into a sign-in card. */
export interface SignInAnswer {
  username: string
  password: string
}

/** What a card answers with: a login, or a plugin's keys. */
export type CardAnswer =
  | import('../../../web/src/lib/types').EmailDraftAnswer
  | import('../../../web/src/lib/types').PluginAnswer
  | SignInAnswer

export interface AttachmentView {
  id: string
  name: string
  kind: import('../../../web/src/lib/media').MediaKind
  /** This phone's own copy, such as a file you just picked. */
  uri?: string | null
  /** The daemon's copy, read when it shows. */
  path?: string
}

/** One entry in a chat transcript, oldest first. */
export type ChatItem =
  | {
      kind: 'message'
      id: string
      role: 'bot' | 'human' | 'user'
      text: string
      /** Who spoke, in rooms. Bot sections can leave it out. */
      author?: FaceSource
      createdAt?: number | null
      streaming?: boolean
      error?: string | null
      attachments?: AttachmentView[]
      /** The bot that spoke, by handle; a bot named in its message opens their conversation. */
      speaker?: string
      /** The history row the message is, when a reaction can name it. */
      rowId?: string
      /** The emoji left on it: yours on a bot's message, the bot's on yours. */
      reactions?: { emoji: string; mine: boolean }[]
    }
  /**
   * One bot messaging another in a turn: "Messaged" Writer, Writer "helped".
   * `bot` and `peer` name the conversation between the two, when it can open.
   */
  | {
      kind: 'ask'
      id: string
      before: string
      after: string
      /** The other bot's name, or "a teammate". */
      name: string
      face?: FaceSource
      bot?: string
      peer?: string
    }
  /** A bot's interactive visual, shown as its own card. */
  | { kind: 'visual'; id: string; title: string; index: number }
  | { kind: 'approval'; id: string; request: ApprovalRequestView }
  | { kind: 'notice'; id: string; text: string; tone?: 'danger' | 'neutral' }
  | { kind: 'day'; id: string; at: number }
