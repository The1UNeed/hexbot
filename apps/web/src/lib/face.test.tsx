import { act, render } from '@testing-library/react'

import { Avatar, LiveFace } from '../components/ui/avatar'
import { HexbotMark } from '../components/ui/wordmark'

import { FACE_MOODS, facePreset, faceShape, moodForStatus } from './face'
import { FACE_REST } from './face-rest'

const frame = () => new Promise(resolve => requestAnimationFrame(resolve))

describe('the live face', () => {
  it('is the morph-bot component, defined once the face module loads', () => {
    expect(customElements.get('morph-bot')).toBeDefined()
    expect(FACE_MOODS[0]).toBe('idle')
    expect(FACE_MOODS).toHaveLength(39)
  })

  it('draws each Hexbot shape as the component shape nearest to it', () => {
    expect(faceShape('hexagon')).toBe('hex')
    expect(faceShape('round')).toBe('blob')
    expect(faceShape('drop')).toBe('teardrop')
    expect(faceShape('nope')).toBe('blob')
    expect(Object.keys(FACE_REST)).toHaveLength(8)
  })

  it('hands the component its state, shape and colours', () => {
    const { container, rerender } = render(
      <LiveFace color="#ec2f8a" eyes="#ffffff" mood="thinking" shape="hexagon" />
    )

    const bot = container.querySelector('morph-bot')!
    expect(bot).toHaveAttribute('state', 'thinking')
    expect(bot).toHaveAttribute('shape', 'hex')
    expect(bot).toHaveAttribute('color', '#ec2f8a')
    expect(bot).toHaveAttribute('eye-color', '#ffffff')
    expect(bot).toHaveAttribute('aria-hidden', 'true')
    expect(bot.shadowRoot?.querySelectorAll('.eye-path')).toHaveLength(2)

    rerender(<LiveFace color="#ec2f8a" eyes="#ffffff" mood="writing" shape="round" />)
    expect(bot).toHaveAttribute('state', 'writing')
    expect(bot).toHaveAttribute('shape', 'blob')
  })

  it('runs the component on its own clock and places the eyes', async () => {
    const { container } = render(
      <LiveFace color="#ec2f8a" eyes="#ffffff" mood="idle" shape="round" />
    )

    const bot = container.querySelector('morph-bot')!

    await act(async () => {
      await frame()
      await frame()
    })

    const eye = bot.shadowRoot!.querySelector('.eye-path')!
    expect(eye.getAttribute('d')).toMatch(/^M[-\d.]+ [-\d.]+L/)
    expect(eye.getAttribute('transform')).toMatch(/^translate\(/)
    expect(bot.shadowRoot!.querySelector('#head-path')!.getAttribute('d')).toBe(
      FACE_REST.round!.head
    )
  })

  it('turns toward a neighbour and holds still through a preset over every state', () => {
    expect(facePreset(null, false)).toBeNull()

    const right = facePreset('right', false)!
    expect(right.states!.idle).toEqual({ headRotation: 10, headX: 2 })
    expect(right.states!.writing).toEqual({ headRotation: 10, headX: 2 })
    expect(Object.keys(right.states!)).toHaveLength(39)

    expect(facePreset('left', true)!.states!.idle).toEqual({
      headRotation: -10,
      headX: -2,
      motionScale: 0
    })

    expect(facePreset(null, true)!.states!.happy).toEqual({ motionScale: 0 })
  })

  it('configures the component when a face looks aside, and resets it after', () => {
    const { container, rerender } = render(
      <Avatar
        look="right"
        mood="listening"
        name="Scout"
        style={{ color: 'pink', shape: 'hexagon' }}
      />
    )

    const bot = container.querySelector('morph-bot')!
    expect(bot.snapshot()?.state).toBe('listening')

    const configure = vi.spyOn(bot, 'configure')
    rerender(<Avatar mood="listening" name="Scout" style={{ color: 'pink', shape: 'hexagon' }} />)
    expect(configure).toHaveBeenCalledWith({})
  })

  it('pairs a status with the face the mobile app gives it', () => {
    expect(moodForStatus('working')).toBe('working')
    expect(moodForStatus('needs_you')).toBe('listening')
    expect(moodForStatus('done')).toBe('happy')
    expect(moodForStatus('idle')).toBe('idle')
    expect(moodForStatus(undefined)).toBe('idle')
  })

  it('draws the mark in the text colour with eyes cut from the background', () => {
    const { container } = render(<HexbotMark mood="loading" />)
    const bot = container.querySelector('morph-bot')!

    expect(bot).toHaveAttribute('color', 'currentColor')
    expect(bot).toHaveAttribute('eye-color', 'var(--hex-background)')
    expect(bot).toHaveAttribute('shape', 'hex')
    expect(bot).toHaveAttribute('state', 'loading')
  })
})
