import { act, fireEvent, render } from '@testing-library/react'

import { Avatar, LiveFace } from '../components/ui/avatar'
import { HexbotMark } from '../components/ui/wordmark'

import { FACE_MOODS, moodForStatus } from './face'
import { AVATAR_SHAPES, eyePlacements, eyeTransformCss, HEX_EYE } from './face-geometry'

const observations: {
  callback: IntersectionObserverCallback
  disconnect: ReturnType<typeof vi.fn<() => void>>
  element?: Element
}[] = []

beforeEach(() => {
  observations.length = 0
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      entry: (typeof observations)[number]
      constructor(callback: IntersectionObserverCallback) {
        this.entry = { callback, disconnect: vi.fn() }
        observations.push(this.entry)
      }
      observe(element: Element) {
        this.entry.element = element
      }
      disconnect() {
        this.entry.disconnect()
      }
    }
  )
})
afterEach(() => vi.unstubAllGlobals())

describe('original faces', () => {
  it('updates every target pose, outline and colour synchronously without scheduling frames', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    const { container, rerender } = render(<LiveFace color="pink" eyes="white" />)
    const svg = container.querySelector('svg')!

    for (const mood of FACE_MOODS) {
      rerender(
        <LiveFace color="blue" eyes="black" look="left" mood={mood} shape="triangle" still />
      )
      expect(svg).toHaveAttribute('data-mood', mood)
      expect(svg).toHaveAttribute('data-moving', 'false')
      expect(svg.querySelector('path')).toHaveAttribute(
        'd',
        AVATAR_SHAPES.find(s => s.id === 'triangle')!.path
      )
      expect(svg.querySelector('path')).toHaveAttribute('fill', 'blue')
      expect(svg.querySelector('.hex-eye-shape')).toHaveAttribute('fill', 'black')
      expect(svg.querySelector('.hex-eye-shape')).toHaveAttribute('d', HEX_EYE)
      expect(svg.querySelector<SVGGElement>('.hex-eye')!.style.transform).toBe(
        eyeTransformCss(eyePlacements(mood)[0]!)
      )
      expect(svg.querySelector('[transform="translate(-10 -2)"]')).not.toBeNull()
    }

    expect(raf).not.toHaveBeenCalled()
    raf.mockRestore()
  })

  it('stops offscreen motion and resumes with current props', () => {
    const { container, rerender, unmount } = render(
      <LiveFace color="pink" eyes="white" mood="working" />
    )

    const observation = observations[0]!

    const intersect = (visible: boolean) =>
      act(() =>
        observation.callback(
          [{ isIntersecting: visible } as IntersectionObserverEntry],
          {} as IntersectionObserver
        )
      )

    intersect(false)
    expect(container.querySelector('svg')).toHaveAttribute('data-moving', 'false')
    rerender(<LiveFace color="blue" eyes="black" mood="writing" />)
    expect(container.querySelector('svg')).toHaveAttribute('data-mood', 'writing')
    intersect(true)
    expect(container.querySelector('svg')).toHaveAttribute('data-moving', 'true')
    unmount()
    expect(observation.disconnect).toHaveBeenCalledOnce()
  })

  it('stops effects while the page is hidden and resumes when it returns', () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const { container, unmount } = render(<LiveFace color="pink" eyes="white" mood="working" />)
    hidden.mockReturnValue(true)
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(container.querySelector('svg')).toHaveAttribute('data-moving', 'false')
    hidden.mockReturnValue(false)
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(container.querySelector('svg')).toHaveAttribute('data-moving', 'true')
    unmount()
    hidden.mockRestore()
  })

  it('keeps keyed faces and their acts together, then cleans all observers and timers on unmount', () => {
    vi.useFakeTimers()

    const rows = (names: string[]) => (
      <>
        {names.map(name => (
          <Avatar key={name} name={name} />
        ))}
      </>
    )

    const { container, rerender, unmount } = render(rows(['Scout', 'Builder']))
    const scout = container.querySelector('[aria-label="Scout"]')!
    fireEvent.click(scout)
    expect(scout.querySelector('[data-act]')).not.toBeNull()
    rerender(rows(['Builder', 'Scout']))
    expect(container.lastChild).toBe(scout)
    expect(scout.querySelector('[data-act]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Builder"] [data-act]')).toBeNull()
    unmount()
    expect(observations.every(item => item.disconnect.mock.calls.length === 1)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it('pairs activity with status and preserves the original brand outline', () => {
    expect(['working', 'needs_you', 'done', 'idle', 'stopped'].map(moodForStatus)).toEqual([
      'working',
      'listening',
      'happy',
      'idle',
      'idle'
    ])
    const { container } = render(<HexbotMark mood="loading" />)
    expect(container.querySelector('path')).toHaveAttribute('fill', 'currentColor')
    expect(container.querySelector('path')).toHaveAttribute(
      'd',
      AVATAR_SHAPES.find(s => s.id === 'hexagon')!.path
    )
    expect(container.querySelector('.hex-eye-shape')).toHaveAttribute(
      'fill',
      'var(--hex-background)'
    )
  })
})
