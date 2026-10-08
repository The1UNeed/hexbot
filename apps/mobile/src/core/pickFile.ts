import { Platform } from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
export async function pickFile(type: string | string[] = '*/*', maxBytes = 45 * 1024 * 1024) {
  const result = await DocumentPicker.getDocumentAsync({ type, copyToCacheDirectory: true })
  if (result.canceled) return null
  const asset = result.assets[0]
  if ((asset.size ?? 0) > maxBytes)
    throw new Error(`Choose a file smaller than ${Math.round(maxBytes / 1024 / 1024)} MiB.`)
  const base64 =
    Platform.OS === 'web'
      ? await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result).split(',')[1])
          reader.onerror = () => reject(new Error('Could not read this file.'))
          if (asset.file) reader.readAsDataURL(asset.file)
          else reject(new Error('Could not read this file.'))
        })
      : await new File(asset.uri).base64()
  const bytes =
    Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0)
  if (bytes > maxBytes) throw new Error('This file exceeds the size limit.')
  return { ...asset, base64, bytes }
}
