import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import * as api from '../../lib/api'

import { MediaView } from './media'

describe('a picture the daemon streams into the chat', () => {
  it('hands Mark up a way to read it whole, as the editor draws bytes', async () => {
    const read = vi
      .spyOn(api, 'filesRead')
      .mockImplementation(async (_session, path, stream = true) => ({
        data_url: stream ? undefined : 'data:image/png;base64,iVBORw0KGgo=',
        mediaUrl: stream ? 'https://daemon.test/api/media/' + 'a'.repeat(32) : undefined,
        mime: 'image/png',
        modified: 0,
        name: 'shot.png',
        path,
        size: 8,
        version: 'v'
      }))

    const onImage = vi.fn()

    render(
      <MediaView
        fallback={null}
        kind="image"
        name="shot.png"
        onImage={onImage}
        path="/work/shot.png"
        sessionId="live-1"
      />
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Open shot.png' }))

    const [src, name, whole] = onImage.mock.calls[0]!

    expect([src, name]).toEqual(['https://daemon.test/api/media/' + 'a'.repeat(32), 'shot.png'])
    await expect(whole()).resolves.toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(read).toHaveBeenLastCalledWith('live-1', '/work/shot.png', false)
    read.mockRestore()
  })
})
