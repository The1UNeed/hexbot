import { Platform } from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import * as ImagePicker from 'expo-image-picker'

/**
 * Where the composer's + takes a file from. Android's camera takes a photo or
 * records a video, never both from one launch, so it has `video` too.
 */
export type AttachSource = 'library' | 'camera' | 'video' | 'files'

/** A file read off this phone, ready to upload. */
export interface PickedFile {
  uri: string
  name: string
  mimeType?: string
  base64: string
  bytes: number
}

/** One file a picker handed back, before it is read. */
interface Asset {
  uri: string
  name: string
  mimeType?: string
  size?: number
  /** The browser's own file, on the web. */
  file?: Blob
}

const LIMIT = 45 * 1024 * 1024

export async function pickFile(type: string | string[] = '*/*', maxBytes = LIMIT) {
  const result = await DocumentPicker.getDocumentAsync({ type, copyToCacheDirectory: true })
  if (result.canceled) return null
  const asset = result.assets[0]
  return { ...asset, ...(await readAsset(fromDocument(asset), maxBytes)) }
}

/**
 * Files for a message, from the phone's photos, its camera, or its files.
 * Every file that fits is returned; `refused` says why the first one that
 * did not fit was left out.
 */
export async function pickAttachments(
  source: AttachSource,
  maxBytes = LIMIT
): Promise<{ files: PickedFile[]; refused: string | null }> {
  const assets = await pickAssets(source)
  const files: PickedFile[] = []
  let refused: string | null = null
  for (const asset of assets) {
    try {
      files.push(await readAsset(asset, maxBytes))
    } catch (e) {
      refused ??= `${asset.name}: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  return { files, refused }
}

async function pickAssets(source: AttachSource): Promise<Asset[]> {
  if (source === 'files') {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: true,
      type: '*/*'
    })
    return result.canceled ? [] : result.assets.map(fromDocument)
  }
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images', 'videos'],
    // A HEIC photo arrives as a JPEG, which every model reads.
    preferredAssetRepresentationMode:
      ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    quality: 1
  }
  let result: ImagePicker.ImagePickerResult
  const camera = source === 'camera' || source === 'video'
  if (camera) {
    if (Platform.OS !== 'web') {
      const permission = await ImagePicker.requestCameraPermissionsAsync()
      if (!permission.granted)
        throw new Error('Hexbot cannot use the camera. Allow it in Settings, then try again.')
    }
    result = await ImagePicker.launchCameraAsync({
      ...options,
      ...(Platform.OS === 'android' && { mediaTypes: source === 'video' ? 'videos' : 'images' })
    }).catch((e: { code?: string }) => {
      // Patched in: a simulator, or a Mac running the app, has no camera.
      if (e?.code === 'ERR_CAMERA_UNAVAILABLE') throw new Error('This device has no camera.')
      throw e
    })
  } else {
    result = await ImagePicker.launchImageLibraryAsync({
      ...options,
      allowsMultipleSelection: true,
      orderedSelection: true,
      selectionLimit: 10
    })
  }
  if (result.canceled) return []
  const at = new Date()
  return result.assets.map((asset, i) => ({
    uri: asset.uri,
    name: camera || !asset.fileName ? capturedName(asset, at, i) : asset.fileName,
    mimeType: asset.mimeType,
    size: asset.fileSize,
    file: asset.file
  }))
}

function fromDocument(asset: DocumentPicker.DocumentPickerAsset): Asset {
  return {
    uri: asset.uri,
    name: asset.name,
    mimeType: asset.mimeType,
    size: asset.size,
    file: asset.file
  }
}

/** `photo-20261108-143005.jpg`, from the picture's own extension. */
export function capturedName(
  asset: Pick<ImagePicker.ImagePickerAsset, 'uri' | 'type' | 'mimeType'>,
  at: Date,
  index = 0
): string {
  const video = asset.type === 'video' || asset.mimeType?.startsWith('video/')
  const fromUri = /\.([a-z0-9]{2,5})(?:[?#].*)?$/i.exec(asset.uri)?.[1]?.toLowerCase()
  const fromMime = asset.mimeType?.split('/')[1]?.replace('quicktime', 'mov').replace('jpeg', 'jpg')
  const extension = fromUri ?? fromMime ?? (video ? 'mp4' : 'jpg')
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  return `${video ? 'video' : 'photo'}-${stamp}${index ? `-${index + 1}` : ''}.${extension}`
}

async function readAsset(asset: Asset, maxBytes: number): Promise<PickedFile> {
  const file = Platform.OS === 'web' ? null : new File(asset.uri)
  const size = asset.size ?? (asset.file as { size?: number } | undefined)?.size ?? file?.size
  if (size == null || !Number.isFinite(size) || size < 0)
    throw new Error('Could not check this file’s size.')
  if (size > maxBytes)
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
      : await file!.base64()
  const bytes =
    Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0)
  if (bytes > maxBytes) throw new Error('This file exceeds the size limit.')
  return { uri: asset.uri, name: asset.name, mimeType: asset.mimeType, base64, bytes }
}
