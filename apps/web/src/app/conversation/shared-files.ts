import type { Message } from '../../lib/types'

/** A file to open beside the chat: the daemon's path for it, or an object URL this page holds. */
export interface FileTarget {
  mime: string
  name: string
  path?: string
  url?: string
}

const MIMES: Record<string, string> = {
  csv: 'text/csv',
  json: 'application/json',
  md: 'text/markdown',
  pdf: 'application/pdf',
  png: 'image/png',
  txt: 'text/plain'
}

export function mimeOf(name: string): string {
  return MIMES[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
}

/** The file's own name: an attachment is kept as `<32-hex id>-<name>`. */
const baseName = (path: string) =>
  (path.split(/[\\/]/).pop() || path).replace(/^[0-9a-f]{32}-(?=.)/, '')

/** The tool a bot calls to hand the user a file; its `path` argument names it. */
export const SHARE_FILE_TOOL = 'hexbot_share_file'

/**
 * The files the bot shared in a message, once each, in the order it shared
 * them. Files it only wrote or edited along the way stay out of the chat.
 */
export function filesOf(message: Pick<Message, 'toolCalls'>): FileTarget[] {
  const seen = new Set<string>()

  return message.toolCalls.flatMap(call => {
    if (call.name !== SHARE_FILE_TOOL || call.status !== 'ok') {
      return []
    }

    const args = typeof call.args === 'string' ? parse(call.args) : call.args
    const path = (args as { path?: unknown } | null)?.path

    if (typeof path !== 'string' || !path || seen.has(path)) {
      return []
    }

    seen.add(path)
    const name = baseName(path)

    return [{ mime: mimeOf(name), name, path }]
  })
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
