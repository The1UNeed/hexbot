import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { routeEvent } from '../../lib/events'
import { useConnection } from '../../stores/connection'
import { useUi } from '../../stores/ui'
import { isPreviewTab, useVisuals } from '../../stores/visuals'

import { PreviewFrame } from './preview-frame'

describe('a preview beside the chat', () => {
  beforeEach(() => {
    useVisuals.setState({ active: null, tabs: [] })
    useConnection.setState({
      target: { deviceToken: 't', host: '192.168.1.10', kind: 'remote', port: 9119, tls: false }
    })
  })

  it('opens beside the chat of the bot that served it, and only that one', () => {
    useUi.setState({ lastSection: { bot: 'owl', section: 'chat' } })

    const event = (bot: string) =>
      routeEvent({
        payload: { bot, computer: 'Studio', path: '/hexbot/preview/abc/', title: 'Studio · 5173' },
        type: 'hexbot.preview.opened'
      } as never)

    event('fox')
    expect(useVisuals.getState().tabs).toEqual([])
    event('owl')
    const [tab] = useVisuals.getState().tabs
    expect(tab && isPreviewTab(tab) && tab.preview.path).toBe('/hexbot/preview/abc/')
    // A path that is not a preview never opens a frame.
    routeEvent({
      payload: { bot: 'owl', path: 'https://example.com' },
      type: 'hexbot.preview.opened'
    } as never)
    expect(useVisuals.getState().tabs).toHaveLength(1)
  })

  it('loads through the daemon in a sandbox that is never the daemon\'s origin', () => {
    render(
      <PreviewFrame
        tab={{
          preview: { computer: 'Studio', path: '/hexbot/preview/abc/' },
          title: 'Studio · 5173',
          toolId: 'preview:/hexbot/preview/abc/'
        }}
      />
    )
    const frame = screen.getByTestId('preview')
    expect(frame).toHaveAttribute('src', 'http://192.168.1.10:9119/hexbot/preview/abc/')
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts')
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(screen.getByTestId('preview-computer')).toHaveTextContent('On Studio')
  })
})
