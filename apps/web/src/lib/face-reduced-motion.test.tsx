import { act, cleanup, render } from '@testing-library/react'

import type { LiveFace as LiveFaceComponent } from '../components/ui/avatar'

import type { MorphBotElement } from './face'

let LiveFace: typeof LiveFaceComponent

beforeAll(async () => {
  // Load the engine with the same media query the browser exposes at startup.
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      addEventListener: vi.fn(),
      matches: true,
      removeEventListener: vi.fn()
    }))
  )
  const avatar = await import('../components/ui/avatar')
  LiveFace = avatar.LiveFace
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

afterAll(() => vi.unstubAllGlobals())

const draw = () =>
  act(() => {
    vi.advanceTimersToNextFrame()
    vi.advanceTimersToNextFrame()
  })

it('redraws changed look and still props at their full pose, then stays still', () => {
  const face = (look: 'left' | 'right', still: boolean) => (
    <LiveFace color="#ec2f8a" eyes="#ffffff" look={look} mood="idle" shape="round" still={still} />
  )

  const { container, rerender } = render(face('right', false))
  const bot = container.querySelector('morph-bot')!
  const head = bot.shadowRoot!.querySelector('#bot-transform')!
  draw()
  expect(head.getAttribute('transform')).toContain('translate(116.27 114.27) rotate(10.00)')

  rerender(face('left', false))
  draw()
  expect(head.getAttribute('transform')).toContain('translate(112.27 114.27) rotate(-10.00)')

  const step = vi.spyOn(bot, 'step')
  rerender(face('left', true))
  draw()
  expect(step).toHaveBeenCalledTimes(2)
  expect(head.getAttribute('transform')).toContain('translate(112.27 114.27) rotate(-10.00)')

  const drawn = bot.shadowRoot!.innerHTML
  act(() => vi.advanceTimersByTime(1000))
  expect(bot.shadowRoot!.innerHTML).toBe(drawn)
})

it('snaps every spring and renders the target eye openness and head transform', () => {
  const { container } = render(<LiveFace color="#ec2f8a" eyes="#ffffff" shape="round" />)
  type Spring = { target: number; v: number; x: number }

  const bot = container.querySelector('morph-bot')! as MorphBotElement & {
    _engine: Record<string, unknown>
  }

  draw()

  const springs = Object.values(bot._engine).filter(
    (value): value is Spring =>
      typeof value === 'object' &&
      value !== null &&
      'target' in value &&
      'v' in value &&
      'x' in value
  )

  expect(springs).toHaveLength(15)

  for (const spring of springs) {
    spring.x = spring.target - 0.3
    spring.v = 2
  }

  bot.configure({
    states: {
      idle: {
        eyeOpen: 0.4,
        eyeScale: 0.8,
        headRotation: 20,
        headX: 12,
        headY: 8,
        scaleY: 0.95
      }
    }
  })
  bot.step()
  draw()

  for (const spring of springs) {
    expect(spring.x).toBe(spring.target)
    expect(spring.v).toBe(0)
  }

  expect(bot.snapshot()?.eyeOpen).toBe(0.4)
  expect(bot.shadowRoot!.querySelector('#bot-transform')!.getAttribute('transform')).toContain(
    'translate(126.27 122.27) rotate(20.00) scale(1.0000 0.9500)'
  )

  for (const eye of bot.shadowRoot!.querySelectorAll('.eye-path')) {
    const scales = eye.getAttribute('transform')!.match(/scale\(([-\d.]+) ([-\d.]+)\)/)!
    expect(Number(scales[2]) / Number(scales[1])).toBeCloseTo(0.4, 3)
    expect(eye.getAttribute('d')).toMatch(/^M[-\d.]+ [-\d.]+L/)
  }
})
