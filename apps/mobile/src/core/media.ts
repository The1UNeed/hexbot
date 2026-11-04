import { toByteArray } from 'base64-js'
import { Directory, File, Paths } from 'expo-file-system'
import { Platform } from 'react-native'

/** What `hexbot.files.read` answers for a picture, video or audio file. */
export interface ReadMedia {
  data_url?: string
  mime: string
  name: string
}

const made = new Map<string, Promise<string>>()
// Two files with one name, read in the same millisecond, get their own copies.
let copies = 0

/**
 * A file the daemon keeps, as a URI this phone plays: a copy in the app's
 * cache on iOS and Android, a blob on the web. Each `key` is read once while
 * the app runs, so scrolling back to it plays at once.
 */
export function mediaUri(key: string, read: () => Promise<ReadMedia>): Promise<string> {
  let uri = made.get(key)
  if (!uri) {
    uri = read().then(save)
    uri.catch(() => made.delete(key))
    made.set(key, uri)
  }
  return uri
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
