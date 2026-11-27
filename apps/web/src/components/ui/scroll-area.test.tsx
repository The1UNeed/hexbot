import { act, render, screen } from '@testing-library/react'

import { Dialog } from './dialog'
import { ScrollArea } from './scroll-area'

const viewportOf = (text: string) => screen.getByText(text).parentElement as HTMLElement

it('floats its controls over the content and keeps the content clear of their measured height', () => {
  // jsdom has no layout: give every element a height of 40px.
  const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(40)

  try {
    render(
      <ScrollArea
        bottom={<button type="button">Send</button>}
        top={<button type="button">Close</button>}
      >
        <p>Body</p>
      </ScrollArea>
    )

    const top = screen.getByRole('button', { name: 'Close' }).parentElement as HTMLElement
    const bottom = screen.getByRole('button', { name: 'Send' }).parentElement as HTMLElement
    expect(top).toHaveClass('hex-chrome', 'hex-drag', 'absolute', 'top-0')
    expect(bottom).toHaveClass('hex-chrome', 'absolute', 'bottom-0')
    expect(bottom).not.toHaveClass('hex-drag')

    // Chrome height plus the 8px gap, for padding and scroll padding alike, so
    // the first and last lines, focus and jumps all land clear of the glass.
    const viewport = viewportOf('Body')
    expect(viewport.style.paddingTop).toBe('48px')
    expect(viewport.style.scrollPaddingTop).toBe('48px')
    expect(viewport.style.paddingBottom).toBe('48px')
    expect(viewport.style.scrollPaddingBottom).toBe('48px')

    // The content fades out across the chrome and is whole where it starts.
    expect(viewport).toHaveClass('hex-fade-mask')
    expect(viewport.style.getPropertyValue('--hex-fade-top')).toBe('48px')
    expect(viewport.style.getPropertyValue('--hex-fade-bottom')).toBe('48px')
  } finally {
    height.mockRestore()
  }
})

it('leaves a bare scroller unpadded and unfaded until there is more to scroll to', () => {
  render(
    <ScrollArea>
      <p>Body</p>
    </ScrollArea>
  )

  const viewport = viewportOf('Body')
  expect(viewport.style.paddingTop).toBe('')
  expect(viewport.style.getPropertyValue('--hex-fade-top')).toBe('0px')
  expect(viewport.style.getPropertyValue('--hex-fade-bottom')).toBe('0px')
  // Focus still lands clear of where a fade would be.
  expect(viewport.style.scrollPaddingTop).toBe('48px')
  expect(viewport.style.scrollPaddingBottom).toBe('48px')
})

it('fades a small box at most a fifth of its height, and keeps focus clear of that', () => {
  // jsdom has no layout or ResizeObserver: a 160px box with content past both edges.
  const observers: ResizeObserverCallback[] = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        observers.push(callback)
      }
      disconnect() {}
      observe() {}
      unobserve() {}
    }
  )
  const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(160)
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000)

  try {
    render(
      <ScrollArea>
        <p>Body</p>
      </ScrollArea>
    )

    const viewport = viewportOf('Body')
    viewport.scrollTop = 400
    act(() => observers.forEach(callback => callback([], {} as ResizeObserver)))

    expect(viewport.style.getPropertyValue('--hex-fade-top')).toBe('32px')
    expect(viewport.style.getPropertyValue('--hex-fade-bottom')).toBe('32px')
    expect(viewport.style.scrollPaddingTop).toBe('32px')
  } finally {
    client.mockRestore()
    scroll.mockRestore()
    vi.unstubAllGlobals()
  }
})

it('hides content behind bare-text chrome, and takes it out of reach there too', () => {
  const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(40)

  try {
    render(
      <ScrollArea hold top={<h2>Title</h2>}>
        <p>Body</p>
      </ScrollArea>
    )

    const viewport = viewportOf('Body')
    // Invisible from 8px above the title's bottom, whole where the content starts.
    expect(viewport.style.getPropertyValue('--hex-fade-top-from')).toBe('32px')
    expect(viewport.style.getPropertyValue('--hex-fade-top')).toBe('48px')
    // Clipped where it is invisible, so a control scrolled under the title cannot be clicked.
    expect(viewport.style.clipPath).toBe('inset(32px 0 1px 0)')
    // The title reads before the content.
    expect(screen.getByRole('heading', { name: 'Title' }).compareDocumentPosition(viewport)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  } finally {
    height.mockRestore()
  }
})

it('lets a window that scrolls its own columns opt out of the dialog scroller', () => {
  render(
    <Dialog label="Settings" open scroll={false}>
      <div className="h-full">Columns</div>
    </Dialog>
  )

  // The content's parent is a plain flex box, so its h-full resolves.
  const parent = screen.getByText('Columns').parentElement as HTMLElement
  expect(parent).toHaveClass('flex', 'min-h-0', 'flex-1', 'flex-col')
  expect(parent).not.toHaveClass('overflow-y-auto')
})
