import { beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({
  size: 100,
  base64: vi.fn(),
  pick: vi.fn(),
  library: vi.fn(),
  camera: vi.fn(),
  permission: vi.fn()
}))
const platform = vi.hoisted(() => ({ OS: 'ios' }))
vi.mock('react-native', () => ({ Platform: platform }))
vi.mock('expo-document-picker', () => ({ getDocumentAsync: mock.pick }))
vi.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: mock.library,
  launchCameraAsync: mock.camera,
  requestCameraPermissionsAsync: mock.permission,
  UIImagePickerPreferredAssetRepresentationMode: { Compatible: 'compatible' }
}))
vi.mock('expo-file-system', () => ({
  File: class {
    get size() {
      return mock.size
    }
    base64() {
      return mock.base64()
    }
  }
}))
import { capturedName, pickAttachments, pickFile } from './pickFile'

beforeEach(() => {
  platform.OS = 'ios'
  mock.size = 100
  mock.base64.mockReset().mockResolvedValue('YQ==')
  mock.pick
    .mockReset()
    .mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///huge', name: 'huge.png' }] })
  mock.library.mockReset()
  mock.camera.mockReset()
  mock.permission.mockReset().mockResolvedValue({ granted: true })
})
describe('native file size', () => {
  it('checks filesystem size before reading base64 when the picker omits size', async () => {
    await expect(pickFile('*/*', 50)).rejects.toThrow('smaller')
    expect(mock.base64).not.toHaveBeenCalled()
  })
  it('refuses unknown size before reading', async () => {
    mock.size = NaN
    await expect(pickFile()).rejects.toThrow('size')
    expect(mock.base64).not.toHaveBeenCalled()
  })
  it('reads a small file and still checks the decoded byte count', async () => {
    expect(await pickFile()).toMatchObject({ bytes: 1, base64: 'YQ==' })
    mock.size = 0
    await expect(pickFile('*/*', 0)).rejects.toThrow('size limit')
  })
})

describe('attaching from the composer', () => {
  it('reads several photos and videos from the library, keeping their names', async () => {
    mock.library.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: 'file:///a.jpg',
          fileName: 'IMG_0001.jpg',
          mimeType: 'image/jpeg',
          fileSize: 10,
          type: 'image'
        },
        {
          uri: 'file:///b.mov',
          fileName: 'IMG_0002.mov',
          mimeType: 'video/quicktime',
          fileSize: 20,
          type: 'video'
        }
      ]
    })
    const { files, refused } = await pickAttachments('library')
    expect(refused).toBe(null)
    expect(files.map(f => [f.name, f.mimeType, f.uri])).toEqual([
      ['IMG_0001.jpg', 'image/jpeg', 'file:///a.jpg'],
      ['IMG_0002.mov', 'video/quicktime', 'file:///b.mov']
    ])
    expect(mock.library).toHaveBeenCalledWith(
      expect.objectContaining({
        allowsMultipleSelection: true,
        mediaTypes: ['images', 'videos'],
        preferredAssetRepresentationMode: 'compatible'
      })
    )
    expect(mock.camera).not.toHaveBeenCalled()
  })

  it('keeps what fits and says why it left one out', async () => {
    mock.library.mockResolvedValue({
      canceled: false,
      assets: [
        { uri: 'file:///a.jpg', fileName: 'small.jpg', fileSize: 10 },
        { uri: 'file:///b.mov', fileName: 'long.mov', fileSize: 100 * 1024 * 1024 }
      ]
    })
    const { files, refused } = await pickAttachments('library')
    expect(files.map(f => f.name)).toEqual(['small.jpg'])
    expect(refused).toMatch(/^long\.mov: Choose a file smaller than 45 MiB/)
  })

  it('asks for the camera, then names what it took', async () => {
    mock.camera.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///cache/ABC.jpg', fileName: 'ABC.jpg', fileSize: 10, type: 'image' }]
    })
    const { files } = await pickAttachments('camera')
    expect(mock.permission).toHaveBeenCalled()
    expect(files[0].name).toMatch(/^photo-\d{8}-\d{6}\.jpg$/)
  })

  it('records a video on Android, whose camera does one or the other', async () => {
    platform.OS = 'android'
    mock.camera.mockResolvedValue({ canceled: true, assets: null })
    await pickAttachments('video')
    await pickAttachments('camera')
    expect(mock.camera.mock.calls.map(([o]) => o.mediaTypes)).toEqual(['videos', 'images'])
  })

  it('opens nothing when the camera is not allowed', async () => {
    mock.permission.mockResolvedValue({ granted: false })
    await expect(pickAttachments('camera')).rejects.toThrow('Allow it in Settings')
    expect(mock.camera).not.toHaveBeenCalled()
  })

  it('says so when the device has no camera', async () => {
    mock.camera.mockRejectedValue(Object.assign(new Error('x'), { code: 'ERR_CAMERA_UNAVAILABLE' }))
    await expect(pickAttachments('camera')).rejects.toThrow('This device has no camera.')
  })

  it('takes several files from the file system', async () => {
    mock.pick.mockResolvedValue({
      canceled: false,
      assets: [
        { uri: 'file:///x.pdf', name: 'x.pdf', size: 5, mimeType: 'application/pdf' },
        { uri: 'file:///y.txt', name: 'y.txt', size: 5 }
      ]
    })
    const { files } = await pickAttachments('files')
    expect(files.map(f => f.name)).toEqual(['x.pdf', 'y.txt'])
    expect(mock.pick).toHaveBeenCalledWith(expect.objectContaining({ multiple: true }))
  })

  it('attaches nothing when the picker is closed', async () => {
    mock.library.mockResolvedValue({ canceled: true, assets: null })
    expect(await pickAttachments('library')).toEqual({ files: [], refused: null })
  })

  it('names a recording as a video, from its own extension', () => {
    const at = new Date(2026, 10, 8, 14, 30, 5)
    expect(capturedName({ uri: 'file:///c/X.MOV', type: 'video' }, at)).toBe(
      'video-20261108-143005.mov'
    )
    expect(capturedName({ uri: 'blob:abc', mimeType: 'image/jpeg' }, at, 1)).toBe(
      'photo-20261108-143005-2.jpg'
    )
  })
})
