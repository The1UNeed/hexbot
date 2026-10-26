import { act, fireEvent, render } from '@testing-library/react'

import { Avatar, LiveFace } from '../components/ui/avatar'
import { HexbotMark } from '../components/ui/wordmark'

import { FACE_MOODS, moodForStatus } from './face'
import { AVATAR_SHAPES, HEX_EYE } from './face-geometry'
import { MORPHS, restFrame } from './face-motion'

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
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('original faces', () => {
  it('rests in every mood, with outline and colours, without scheduling frames while held', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    const { container, rerender } = render(<LiveFace color="pink" eyes="white" still />)
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
      const rest = restFrame(mood, 'left')
      expect(svg.querySelector('.hex-eye')).toHaveAttribute('transform', rest.eyes[0])
      expect(svg.querySelector('[data-part="head"]')).toHaveAttribute('transform', rest.head)
      expect(svg.querySelector('[data-part="body"]')).toHaveAttribute(
        'display',
        MORPHS[mood] ? 'none' : 'inline'
      )
      expect(
        [...svg.querySelectorAll('[data-part="morph"]')]
          .filter(morph => morph.getAttribute('display') === 'inline')
          .map(morph => morph.getAttribute('data-morph'))
      ).toEqual(MORPHS[mood] ? [MORPHS[mood]] : [])
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

  it('moves a visible face frame by frame and returns it to rest when held', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })

    const { container, rerender, unmount } = render(
      <LiveFace color="pink" eyes="white" mood="working" />
    )

    const head = container.querySelector('[data-part="head"]')!
    const rest = restFrame('working').head
    expect(head).toHaveAttribute('transform', rest)
    act(() => vi.advanceTimersByTime(700))
    expect(head.getAttribute('transform')).not.toBe(rest)
    rerender(<LiveFace color="pink" eyes="white" mood="working" still />)
    expect(head).toHaveAttribute('transform', rest)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it('folds into its morph and back, and throws sparks when it wakes', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    const { container, rerender } = render(<LiveFace color="pink" eyes="white" mood="sleeping" />)
    const part = (name: string) => container.querySelector(`[data-part="${name}"]`)!
    const dots = container.querySelector('[data-morph="dots"]')!
    rerender(<LiveFace color="pink" eyes="white" mood="idle" />)
    act(() => vi.advanceTimersByTime(100))
    expect(part('sparks')).toHaveAttribute('display', 'inline')
    act(() => vi.advanceTimersByTime(1000))
    expect(part('sparks')).toHaveAttribute('display', 'none')
    rerender(<LiveFace color="pink" eyes="white" mood="thinking" />)
    act(() => vi.advanceTimersByTime(1000))
    expect(part('body')).toHaveAttribute('display', 'none')
    expect(dots).toHaveAttribute('display', 'inline')
    rerender(<LiveFace color="pink" eyes="white" mood="idle" />)
    act(() => vi.advanceTimersByTime(1000))
    expect(part('body')).toHaveAttribute('display', 'inline')
    expect(dots).toHaveAttribute('display', 'none')
    vi.useRealTimers()
  })

  it('rests under reduced motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      addEventListener: () => undefined,
      matches: query.includes('reduce'),
      removeEventListener: () => undefined
    }))
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    const { container } = render(<LiveFace color="pink" eyes="white" mood="happy" />)
    expect(container.querySelector('svg')).toHaveAttribute('data-moving', 'false')
    expect(raf).not.toHaveBeenCalled()
    raf.mockRestore()
  })

  it('turns toward the face it looks at', () => {
    const { container, rerender } = render(<LiveFace color="pink" eyes="white" look="left" still />)
    const head = container.querySelector('[data-part="head"]')!
    expect(container.querySelector('svg')).toHaveAttribute('data-look', 'left')
    expect(head).toHaveAttribute('transform', restFrame('idle', 'left').head)
    rerender(<LiveFace color="pink" eyes="white" look={null} still />)
    expect(container.querySelector('svg')).not.toHaveAttribute('data-look')
    expect(head).toHaveAttribute('transform', restFrame('idle').head)
  })
})
