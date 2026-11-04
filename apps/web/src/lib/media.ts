// What a message plays or shows: files you attached, kept by the daemon, and
// the files a bot's media tools made. Shared by the web and mobile apps.

/** The tools whose results name a file the chat shows, each as `MEDIA:<path>`. */
export const MEDIA_TOOLS = new Set([
  'image_generate',
  'text_to_speech',
  'video_generate'
])

export type MediaKind = 'audio' | 'file' | 'image' | 'pdf' | 'video'

export interface MediaFile {
  kind: MediaKind
  mime: string
  name: string
  path: string
}

const MIMES: Record<string, string> = {
  aac: 'audio/aac',
  csv: 'text/csv',
  flac: 'audio/flac',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  m4a: 'audio/mp4',
  m4v: 'video/mp4',
  md: 'text/markdown',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  pdf: 'application/pdf',
  png: 'image/png',
  txt: 'text/plain',
  wav: 'audio/wav',
  webm: 'video/webm',
  webp: 'image/webp'
}

export function mimeOf(name: string): string {
  return MIMES[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
}

export function mediaKind(mime: string, name = ''): MediaKind {
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') {
    return 'image'
  }

  if (mime.startsWith('video/')) {
    return 'video'
  }

  if (mime.startsWith('audio/')) {
    return 'audio'
  }

  return mime === 'application/pdf' || name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'file'
}

/** The file's own name: an attachment is kept as `<32-hex id>-<name>`. */
export function baseName(path: string): string {
  return (path.split(/[\\/]/).pop() || path).replace(/^[0-9a-f]{32}-(?=.)/, '')
}

function mediaFile(path: string): MediaFile {
  const name = baseName(path)
  const mime = mimeOf(name)

  return { kind: mediaKind(mime, name), mime, name, path }
}

const ATTACHED = /(?:^|\n\n)Attached files:\n(.+)$/s

/**
 * Your message as the daemon keeps it: the words, then the files that went
 * with it, listed under "Attached files:".
 */
export function splitAttached(text: string): { files: MediaFile[]; text: string } {
  const match = ATTACHED.exec(text)

  if (!match) {
    return { files: [], text }
  }

  const paths = match[1]!.split('\n').filter(line => line.trim())

  return { files: paths.map(mediaFile), text: text.slice(0, match.index) }
}

/** Every `MEDIA:<path>` in a tool's result, as a Pi result object or its text. */
function mediaPaths(value: unknown, found: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.startsWith('MEDIA:')) {
      found.push(value.slice('MEDIA:'.length).trim())
    } else if (/^\s*[[{]/.test(value)) {
      try {
        mediaPaths(JSON.parse(value), found)
      } catch {
        // Text that only looks like JSON names no file.
      }
    }
  } else if (Array.isArray(value)) {
    value.forEach(item => mediaPaths(item, found))
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach(item => mediaPaths(item, found))
  }

  return found
}

/** The files a bot's finished media tools made in one message, once each, in order. */
export function mediaOf(calls: { name: string; result: unknown; status: string }[]): MediaFile[] {
  const seen = new Set<string>()

  return calls.flatMap(call =>
    call.status === 'ok' && MEDIA_TOOLS.has(call.name)
      ? mediaPaths(call.result)
          .filter(path => path && !seen.has(path) && seen.add(path))
          .map(mediaFile)
      : []
  )
}
