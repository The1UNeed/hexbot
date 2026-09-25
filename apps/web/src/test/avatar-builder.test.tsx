import { render, screen } from '@testing-library/react'

import { isSubscription } from '../components/provider-panel'
import { AvatarBuilder } from '../components/ui/avatar-builder'
import { Thinking } from '../components/ui/thinking'
import { AVATAR_COLORS, AVATAR_SHAPES, avatarSvg, avatarSvgDataUrl } from '../lib/avatar-builder'

describe('avatar builder', () => {
  it('draws the chosen shape in the chosen colour with a face', () => {
    const svg = avatarSvg({ color: 'pink', shape: 'hexagon' })
    const hexagon = AVATAR_SHAPES.find(item => item.id === 'hexagon')!
    const pink = AVATAR_COLORS.find(item => item.id === 'pink')!

    expect(svg).toContain(hexagon.path)
    expect(svg).toContain(pink.value)
    expect(svg.match(/<ellipse/g)).toHaveLength(2)
    expect(avatarSvgDataUrl({ color: 'pink', shape: 'hexagon' })).toMatch(/^data:image\/svg\+xml/)
  })

  it('falls back to the first shape and colour for unknown ids', () => {
    expect(avatarSvg({ color: 'nope', shape: 'nope' })).toContain(AVATAR_SHAPES[0]!.path)
  })

  it('offers every shape and colour as a pressable button', () => {
    const onChange = vi.fn()
    render(<AvatarBuilder onChange={onChange} value={{ color: 'blue', shape: 'round' }} />)

    expect(screen.getByRole('button', { name: 'Round', pressed: true })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sky', pressed: true })).toBeInTheDocument()
    screen.getByRole('button', { name: 'Cloud' }).click()
    expect(onChange).toHaveBeenCalledWith({ color: 'blue', shape: 'cloud' })
  })
})

describe('thinking', () => {
  it('announces what the bot is doing', () => {
    render(<Thinking name="Scout" />)
    expect(screen.getByRole('status', { name: 'Scout is working' })).toBeInTheDocument()
  })
})

describe('isSubscription', () => {
  it('treats any oauth auth type as a browser sign-in', () => {
    expect(isSubscription({ auth_type: 'oauth_external' })).toBe(true)
    expect(isSubscription({ auth_type: 'oauth_device_code' })).toBe(true)
    expect(isSubscription({ auth_type: 'api_key' })).toBe(false)
  })
})
