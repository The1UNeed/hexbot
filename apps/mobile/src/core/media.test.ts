import { beforeEach, expect, it, vi } from 'vitest'

const files = vi.hoisted(() => ({
  written: [] as { name: string; content: string; encoding?: string }[]
}))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///cache' },
  Directory: class {
    create() {}
  },
  File: class {
    uri: string
    constructor(
      _folder: unknown,
      readonly name: string
    ) {
      this.uri = `file:///cache/hexbot-media/${name}`
    }
    async write(content: string, options?: { encoding?: string }) {
      files.written.push({ name: this.name, content, encoding: options?.encoding })
    }
  }
}))

import { mediaUri } from './media'

beforeEach(() => {
  files.written = []
})

it('keeps one copy of a daemon file on the phone and plays from it', async () => {
  const read = vi.fn(async () => ({
    data_url: 'data:audio/mpeg;base64,SUQz',
    mime: 'audio/mpeg',
    name: 'a 1.mp3'
  }))
  const first = await mediaUri('d:/art/a1.mp3', read)
  expect(first).toMatch(/^file:\/\/\/cache\/hexbot-media\/.+-a_1\.mp3$/)
  expect(files.written).toEqual([
    { name: expect.stringMatching(/a_1\.mp3$/), content: 'SUQz', encoding: 'base64' }
  ])
  expect(await mediaUri('d:/art/a1.mp3', read)).toBe(first)
  expect(read).toHaveBeenCalledOnce()
})

it('reads again after a failed read, and refuses text', async () => {
  const text = vi.fn(async () => ({ mime: 'text/plain', name: 'notes.txt' }))
  await expect(mediaUri('d:/notes.txt', text)).rejects.toThrow('cannot play')
  await expect(mediaUri('d:/notes.txt', text)).rejects.toThrow('cannot play')
  expect(text).toHaveBeenCalledTimes(2)
})

it('gives two files with one name their own copies', async () => {
  const read = (data: string) => async () => ({
    data_url: `data:video/mp4;base64,${data}`,
    mime: 'video/mp4',
    name: 'clip.mp4'
  })
  const [first, second] = await Promise.all([
    mediaUri('d:/a/clip.mp4', read('AAAA')),
    mediaUri('d:/b/clip.mp4', read('BBBB'))
  ])
  expect(first).not.toBe(second)
  expect(files.written.map(file => file.content)).toEqual(['AAAA', 'BBBB'])
})
