import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useFaceColor } from '../../components/ui/avatar'
import { resolveStyle, styleForName } from '../../lib/avatar-builder'

import { botBubbleStyle } from './index'

const photo = { data: 'data:image/jpeg;base64,/9j/4AAQ', mime: 'image/jpeg' }
const nameColor = (name: string) => resolveStyle(styleForName(name)).color.value

describe('bot bubbles', () => {
  it('washes the bubble with the face colour and strengthens secondary text', () => {
    expect(botBubbleStyle('#f97316')).toEqual({
      '--hex-muted-text': 'var(--hex-bot-muted)',
      backgroundColor: 'color-mix(in srgb, #f97316 var(--hex-bot-wash), var(--hex-bubble))'
    })
  })

  it('keeps the plain bubble for a photo, with the same secondary text', () => {
    expect(botBubbleStyle(null)).toEqual({ '--hex-muted-text': 'var(--hex-bot-muted)' })
  })

  it('takes the colour of the face picked in an app, whatever its picture', () => {
    const bot = { avatar: photo, face: { color: 'orange', shape: 'pill' } }
    const { result } = renderHook(() => useFaceColor(bot, 'Ada'))

    expect(result.current).toBe('#f97316')
  })

  it('has no colour for a photo', async () => {
    const bot = { avatar: photo, face: null }
    const { result } = renderHook(() => useFaceColor(bot, 'Ada'))

    await waitFor(() => expect(result.current).toBeNull())
  })

  it('takes the colour from the name when there is no picture', () => {
    expect(renderHook(() => useFaceColor({ avatar: null }, 'Ada')).result.current).toBe(
      nameColor('Ada')
    )
    expect(renderHook(() => useFaceColor(undefined, 'Ada')).result.current).toBe(nameColor('Ada'))
    expect(renderHook(() => useFaceColor(undefined, null)).result.current).toBeNull()
  })
})
