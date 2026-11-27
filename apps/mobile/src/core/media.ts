import { toByteArray } from 'base64-js'
import { Directory, File, Paths } from 'expo-file-system'
import { Platform } from 'react-native'

/** What `hexbot.files.read` answers for a picture, video or audio file. */
export interface ReadMedia {
  mediaUrl?: string
  data_url?: string
  mime: string
  name: string
}

const made = new Map<string, string>()
const pending = new Map<string, Promise<string>>()
// Two files with one name, read in the same millisecond, get their own copies.
let copies = 0

/**
 * The native player can stream a daemon URL directly. Keep local copies
 * from older daemons so scrolling back doesn't download their bytes again.
 */
export function mediaUri(
  key: string,
  read: () => Promise<ReadMedia>,
  connection = 0
): Promise<string> {
  const local = made.get(key)
  if (local) return Promise.resolve(local)

  const request = JSON.stringify([key, connection])
  const reading = pending.get(request)
  if (reading) return reading
  const result = read()
    .then(async file => {
      if (file.mediaUrl) return file.mediaUrl
      const uri = await save(file)
      made.set(key, uri)
      return uri
    })
    .finally(() => pending.delete(request))
  pending.set(request, result)
  return result
}

async function save(file: ReadMedia): Promise<string> {
  const match = /^data:([^;,]*)[^,]*;base64,(.*)$/s.exec(file.data_url ?? '')
  if (!match) throw new Error('This file cannot play here.')
  if (Platform.OS === 'web')
    return URL.createObjectURL(
      new Blob([toByteArray(match[2]) as Uint8Array<ArrayBuffer>], { type: match[1] || file.mime })
    )
  const folder = new Directory(Paths.cache, 'hexbot-media')
  folder.create({ idempotent: true, intermediates: true })
  const copy = new File(
    folder,
    `${Date.now().toString(36)}-${++copies}-${file.name.replace(/[^\w.-]/g, '_')}`
  )
  await copy.write(match[2], { encoding: 'base64' })
  return copy.uri
}

let shares = 0

/**
 * A file the daemon read, as a copy on this phone under its own name, for the
 * share sheet and the PDF viewer. Each copy gets its own folder, so two files
 * with one name never meet. Not on the web, which has no share sheet for files.
 */
export async function fileCopy(file: {
  mediaUrl?: string
  data_url?: string
  name: string
  text?: string
}): Promise<{ folder: string; uri: string }> {
  const match = /^data:[^,]*;base64,(.*)$/s.exec(file.data_url ?? '')
  if (!file.mediaUrl && !match && file.text === undefined)
    throw new Error('This file cannot be copied here.')
  const folder = new Directory(
    Paths.cache,
    'hexbot-files',
    `${Date.now().toString(36)}-${++shares}`
  )
  folder.create({ idempotent: true, intermediates: true })
  const copy = new File(folder, file.name.replace(/[/\\:]/g, '_') || 'file')
  if (file.mediaUrl) await File.downloadFileAsync(file.mediaUrl, copy)
  else if (match) await copy.write(match[1]!, { encoding: 'base64' })
  else await copy.write(file.text!)
  return { folder: folder.uri, uri: copy.uri }
}
