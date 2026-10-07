/**
 * Design tokens for the phone, following docs/ui-design.md: the chrome is
 * greys, colour comes from bot faces, the accent is reserved for unread dots
 * and links. Liquid glass is for floating chrome only (header buttons, the
 * name pill, the composer); content is never glass.
 */

import { useColorScheme } from 'react-native'

import { useUi } from '../stores/ui'

const light = {
  accent: '#4F46E5',
  bg: '#FFFFFF',
  border: '#E3E3E3',
  bubbleBot: '#F2F2F3',
  bubbleUser: '#141414',
  bubbleUserText: '#FFFFFF',
  canvas: '#F7F7F8',
  danger: '#D92D20',
  hairline: 'rgba(0,0,0,0.08)',
  primary: '#141414',
  primaryText: '#FFFFFF',
  success: '#16A34A',
  surface: '#F5F5F5',
  surface2: '#EBEBEB',
  surface3: '#DEDEDE',
  text: '#141414',
  textFaint: '#A3A3A3',
  textMuted: '#767676',
  warning: '#B54708',
  working: '#2563EB'
}

const dark: typeof light = {
  accent: '#8B85FF',
  bg: '#0E0E0E',
  border: '#2A2A2A',
  bubbleBot: '#1C1C1E',
  bubbleUser: '#F4F4F4',
  bubbleUserText: '#0E0E0E',
  canvas: '#0E0E0E',
  danger: '#F4645B',
  hairline: 'rgba(255,255,255,0.10)',
  primary: '#F4F4F4',
  primaryText: '#0E0E0E',
  success: '#34C759',
  surface: '#171717',
  surface2: '#262626',
  surface3: '#343434',
  text: '#F4F4F4',
  textFaint: '#5C5C5C',
  textMuted: '#8E8E8E',
  warning: '#F7B24A',
  working: '#4C8DFF'
}

export type Palette = typeof light

export const radii = {
  bubble: 20,
  card: 14,
  control: 10,
  pill: 999
} as const

/** iOS text styles; sizes in points. */
export const type = {
  body: { fontSize: 17, lineHeight: 23 },
  callout: { fontSize: 16, lineHeight: 21 },
  caption: { fontSize: 12, lineHeight: 16 },
  footnote: { fontSize: 13, lineHeight: 18 },
  headline: { fontSize: 17, fontWeight: '600' as const, lineHeight: 22 },
  largeTitle: { fontSize: 34, fontWeight: '700' as const, lineHeight: 41 },
  row: { fontSize: 19, fontWeight: '500' as const, lineHeight: 24 },
  subhead: { fontSize: 15, lineHeight: 20 },
  title: { fontSize: 22, fontWeight: '600' as const, lineHeight: 28 }
} as const

export interface Theme {
  colors: Palette
  dark: boolean
}

export function useTheme(): Theme {
  const system = useColorScheme()
  const preference = useUi(state => state.theme)
  const isDark = preference === 'system' ? system === 'dark' : preference === 'dark'

  return { colors: isDark ? dark : light, dark: isDark }
}

export const palettes = { dark, light }
