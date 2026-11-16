import type { Rpc } from './types'

/** One part of a file as base64: 768 KiB in whole groups of four, so each part decodes alone. */
export const PART_CHARS = 1024 * 1024

/** Sessions whose daemon refused parts once: they are not asked again. */
const wholeOnly = new Set<string>()

/** A new daemon process, as after an update, may take parts: ask again. */
export function forgetWholeOnly() {
  wholeOnly.clear()
}

/** A daemon from before a method, such as part uploads. */
export function unknownMethod(e: unknown): boolean {
  const code = (e as { code?: number } | null)?.code
  const message = e instanceof Error ? e.message : String(e)
  return code === -32601 || /unknown (runtime )?method|method not found/i.test(message)
}

/**
 * A daemon from before part uploads, asked to stage a file ahead of Send. It
 * cannot take a file back either, so the file stays on the phone until Send.
 */
export class WholeFilesOnly extends Error {
  constructor() {
    super('This daemon takes files only when the message is sent.')
    this.name = 'WholeFilesOnly'
  }
}

/**
 * Stages a picked file: its base64 goes in parts, `onProgress` hearing the
 * share the daemon has, then `method` names the upload. A daemon from before
 * part uploads gets the file whole, or, with `ahead` (staging before Send),
 * nothing and `WholeFilesOnly`. Once `wanted` says no, no more parts go.
 */
export async function attachInParts<T>(
  rpc: Rpc,
  sessionId: string,
  method: string,
  params: Record<string, unknown>,
  upload: string,
  {
    ahead = false,
    onProgress = () => {},
    wanted = () => true
  }: { ahead?: boolean; onProgress?: (fraction: number) => void; wanted?: () => boolean } = {}
): Promise<T> {
  const { content_base64, data_url, ...rest } = params
  const payload =
    typeof content_base64 === 'string' ? content_base64 : (String(data_url ?? '').split(',')[1] ?? '')
  if (wholeOnly.has(sessionId)) {
    if (ahead) throw new WholeFilesOnly()
    return rpc<T>(method, { ...params, session_id: sessionId })
  }
  for (let offset = 0; offset === 0 || offset < payload.length; offset += PART_CHARS) {
    if (!wanted()) throw new Error('The file was taken out.')
    try {
      await rpc('attachments.part', {
        session_id: sessionId,
        upload,
        offset: (offset / 4) * 3,
        data: payload.slice(offset, offset + PART_CHARS)
      })
    } catch (e) {
      if (offset === 0 && unknownMethod(e)) {
        wholeOnly.add(sessionId)
        if (ahead) throw new WholeFilesOnly()
        return rpc<T>(method, { ...params, session_id: sessionId })
      }
      throw e
    }
    // Whole only once the daemon has staged it, which for a PDF means drawing its pages.
    onProgress(payload.length ? Math.min(0.99, (offset + PART_CHARS) / payload.length) : 0.99)
  }
  return rpc<T>(method, { ...rest, session_id: sessionId, upload })
}
export function attachmentPrompt(text: string, hasAttachments: boolean): string {
  return text.trim() || (hasAttachments ? 'Please review the attached files.' : '')
}
export function imageMime(name: string, mime?: string): string | undefined {
  const images = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
  if (mime && images.includes(mime)) return mime
  const extension = name.toLowerCase().split('.').at(-1) ?? ''
  return (
    {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp'
    } as Record<string, string>
  )[extension]
}
/** What the question tool receives: one answer, or every chosen answer as a JSON array, as on the web. */
export function encodeAnswer(multiSelect: boolean, chosen: string[], typed: string): string {
  const own = typed.trim()
  if (multiSelect) return JSON.stringify(own ? [...chosen, own] : chosen)
  return own || chosen[0] || ''
}
