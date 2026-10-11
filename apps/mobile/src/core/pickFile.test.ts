import { beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ size: 100, base64: vi.fn(), pick: vi.fn() }))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-document-picker', () => ({ getDocumentAsync: mock.pick }))
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
import { pickFile } from './pickFile'

beforeEach(() => {
  mock.size = 100
  mock.base64.mockReset().mockResolvedValue('YQ==')
  mock.pick
    .mockReset()
    .mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///huge', name: 'huge.png' }] })
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
