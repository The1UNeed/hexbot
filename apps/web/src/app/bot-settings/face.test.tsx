import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { vi } from 'vitest'

import type * as AvatarBuilder from '../../lib/avatar-builder'
import type { Bot } from '../../lib/types'
import { useBots } from '../../stores/bots'

import { FaceTab } from './face'
import { ProfileFace } from './shared'

const navigate = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

// jsdom has no canvas: the picture of a face is whatever names it.
vi.mock('../../lib/avatar-builder', async original => ({
  ...(await original<typeof AvatarBuilder>()),
  avatarPng: (style: AvatarBuilder.AvatarStyle) =>
    Promise.resolve(`data:image/png;base64,${style.shape}-${style.color}`)
}))

const scout = {
  avatar: null,
  created_at: 0,
  description: '',
  display_name: 'Scout',
  dream_enabled: true,
  face: { color: 'teal', shape: 'hexagon' },
  last_activity_at: 0,
  model: null,
  name: 'scout',
  owner_id: 'local',
  persona: '',
  provider: null,
  sections_recent: [],
  sections_total: 0,
  skills: [],
  title: '',
  tools: [],
  updated_at: 0
} satisfies Bot

const photo = { data: 'data:image/jpeg;base64,/9j/4AAQ', mime: 'image/jpeg' }

beforeEach(() => {
  navigate.mockClear()
  useBots.setState({ byName: { scout }, order: ['scout'] })
})

describe('the Face page', () => {
  it('shows the face first, then saves each pick at once with its picture', async () => {
    const onSave = vi.fn()
    render(<FaceTab bot={scout} onSave={onSave} />)

    expect(screen.getByRole('heading', { name: 'Face' })).toBeInTheDocument()
    expect(screen.getByTestId('face-stage')).toHaveTextContent('Scout')
    expect(screen.getByTestId('face-stage')).toHaveTextContent('This is how my messages look.')
    expect(screen.getByRole('button', { name: 'Hexagon', pressed: true })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Lagoon', pressed: true })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Star' }))

    // The page shows the pick before the daemon answers.
    expect(screen.getByRole('button', { name: 'Star', pressed: true })).toBeInTheDocument()
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        avatar: 'data:image/png;base64,star-teal',
        face: { color: 'teal', shape: 'star' }
      })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Lemon' }))
    await waitFor(() =>
      expect(onSave).toHaveBeenLastCalledWith({
        avatar: 'data:image/png;base64,star-yellow',
        face: { color: 'yellow', shape: 'star' }
      })
    )
  })

  it('shuffles to a face no bot has, this one included', async () => {
    const onSave = vi.fn()
    const pip = { ...scout, face: { color: 'pink', shape: 'drop' }, name: 'pip' }
    const owl = { ...scout, face: null, kept_face: { color: 'red', shape: 'cat' }, name: 'owl' }
    useBots.setState({ byName: { owl, pip, scout }, order: ['scout', 'pip', 'owl'] })
    render(<FaceTab bot={scout} onSave={onSave} />)

    fireEvent.click(screen.getByRole('button', { name: 'Shuffle' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))

    const { face } = onSave.mock.calls[0]![0] as { face: AvatarBuilder.AvatarStyle }

    expect([scout.face, pip.face, owl.kept_face]).not.toContainEqual(face)
    expect(['white', 'brown', 'gray']).not.toContain(face.color)
  })

  it('fades the choices behind a photo, and either a pick or one button brings the face back', async () => {
    const onSave = vi.fn()
    const withPhoto = { ...scout, avatar: photo, face: null, kept_face: scout.face }
    render(<FaceTab bot={withPhoto} onSave={onSave} />)

    expect(screen.getByTestId('face-stage').querySelector('img')).toHaveAttribute('src', photo.data)
    expect(screen.queryByRole('button', { pressed: true })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Shuffle' })).toBeNull()
    expect(
      screen.getByText('Scout shows a photo. Pick a shape or a colour to go back to a face.')
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Back to a face' }))
    expect(onSave).toHaveBeenLastCalledWith({ avatar: null })

    // A pick starts from the face the photo put aside.
    fireEvent.click(screen.getByRole('button', { name: 'Ghost' }))
    await waitFor(() =>
      expect(onSave).toHaveBeenLastCalledWith({
        avatar: 'data:image/png;base64,ghost-teal',
        face: { color: 'teal', shape: 'ghost' }
      })
    )
  })

  it('takes a photo of the kinds and size the daemon keeps, and says why not otherwise', async () => {
    const onSave = vi.fn()
    render(<FaceTab bot={scout} onSave={onSave} />)
    const input = screen.getByLabelText('Photo')

    fireEvent.change(input, { target: { files: [new File(['x'], 'me.gif', { type: 'image/gif' })] } })
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a PNG, JPEG, or WebP image.')

    const large = new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'me.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [large] } })
    expect(screen.getByRole('alert')).toHaveTextContent('The photo must be 2 MB or smaller.')
    expect(onSave).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { files: [new File(['x'], 'me.png', { type: 'image/png' })] } })
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0]![0]).toEqual({ avatar: expect.stringMatching(/^data:image\/png/) })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('the face on Profile', () => {
  it('is one button that says what it does and opens the Face page', () => {
    render(<ProfileFace bot={scout} />)

    fireEvent.click(screen.getByRole('button', { name: 'Change face' }))
    expect(screen.getByText('Change face')).toBeInTheDocument()
    expect(navigate).toHaveBeenCalledWith({
      params: { bot: 'scout', tab: 'face' },
      to: '/b/$bot/settings/$tab'
    })
  })
})
