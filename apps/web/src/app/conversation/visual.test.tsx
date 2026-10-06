import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ToolCall } from '../../lib/types'

import { readVisualTheme, visualDocument, visualsOf } from './visual'
import { VisualFrame } from './visual-frame'

const call = (partial: Partial<ToolCall>): ToolCall => ({
  args: { html: '<p>chart</p>', title: 'Costs' },
  durationS: 0,
  name: 'hexbot_show_html',
  result: null,
  startedAt: 0,
  status: 'ok',
  toolId: 't1',
  ...partial
})

const theme = { appearance: 'dark' as const, variables: { '--background': '#0e0e0e' } }

describe('visualsOf', () => {
  it('keeps finished visuals, live or restored, and skips the rest', () => {
    const visuals = visualsOf({
      toolCalls: [
        call({}),
        call({ args: '{"html":"<svg></svg>","title":"Map"}', toolId: 't2' }),
        call({ status: 'error', toolId: 't3' }),
        call({ status: 'running', toolId: 't4' }),
        call({ args: { html: ' ', title: 'Empty' }, toolId: 't5' }),
        call({ name: 'terminal', toolId: 't6' })
      ]
    })

    expect(visuals).toEqual([
      { html: '<p>chart</p>', title: 'Costs', toolId: 't1' },
      { html: '<svg></svg>', title: 'Map', toolId: 't2' }
    ])
  })
})

describe('visualDocument', () => {
  it('puts the theme and bootstrap ahead of the page, under one doctype', () => {
    const document = visualDocument('<!DOCTYPE html><html><body>hi</body></html>', theme)

    expect(document.match(/<!doctype/gi)).toHaveLength(1)
    expect(document.startsWith('<!doctype html><style id="hexbot-theme">')).toBe(true)
    expect(document.endsWith('<html><body>hi</body></html>')).toBe(true)
  })

  it('keeps theme values from closing the bootstrap script', () => {
    const document = visualDocument('<p>hi</p>', {
      appearance: 'light',
      variables: { '--font-sans': '</script><script>alert(1)</script>' }
    })

    expect(document.match(/<\/script>/g)).toHaveLength(1)
  })
})

describe('readVisualTheme', () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme
    document.documentElement.style.cssText = ''
  })

  it('follows the theme the user chose and maps the app tokens', () => {
    document.documentElement.dataset.theme = 'dark'
    document.documentElement.style.setProperty('--hex-chart-1', '#8b85ff')

    expect(readVisualTheme()).toMatchObject({
      appearance: 'dark',
      variables: { '--chart-1': '#8b85ff' }
    })
  })
})

describe('VisualFrame', () => {
  it('writes the page once the frame is ready and follows its height', () => {
    render(<VisualFrame visual={{ html: '<p>chart</p>', title: 'Costs', toolId: 't1' }} />)
    const frame = screen.getByTitle('Costs') as HTMLIFrameElement
    const target = frame.contentWindow!
    const post = vi.spyOn(target, 'postMessage').mockImplementation(() => {})

    const send = (data: unknown, source: Window = target) =>
      act(() => {
        window.dispatchEvent(new MessageEvent('message', { data, source }))
      })

    send({ jsonrpc: '2.0', method: 'hexbot/visual/ready' })
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'hexbot/visual/show',
        params: { document: expect.stringContaining('<p>chart</p>') }
      }),
      '*'
    )

    send({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 432.2 } })
    expect(frame.style.height).toBe('433px')

    send({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 9000 } })
    expect(frame.style.height).toBe('2000px')

    // A link the page asks for waits for the user to open it from the app.
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    send({
      id: 'link-1',
      jsonrpc: '2.0',
      method: 'ui/open-link',
      params: { url: 'https://example.com/costs' }
    })
    send({
      id: 'link-2',
      jsonrpc: '2.0',
      method: 'ui/open-link',
      params: { url: 'javascript:alert(1)' }
    })
    expect(screen.queryByRole('button', { name: /Open/ })).toBeNull()
    send({
      id: 'link-3',
      jsonrpc: '2.0',
      method: 'ui/open-link',
      params: { url: 'https://example.com/costs' }
    })
    expect(open).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open example.com/costs' }))
    expect(open).toHaveBeenCalledWith('https://example.com/costs', '_blank', 'noopener,noreferrer')
    expect(screen.queryByRole('button', { name: /Open/ })).toBeNull()

    // Another window cannot resize the frame.
    send(
      { jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 10 } },
      window
    )
    expect(frame.style.height).toBe('2000px')
  })
})
