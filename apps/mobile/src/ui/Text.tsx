import { Text as NativeText, type TextProps as NativeTextProps } from 'react-native'

import { type Palette, type TypeVariant, type as scale, useTheme } from './theme'

export type TextTone = 'accent' | 'danger' | 'faint' | 'muted' | 'onInk' | 'text'

export interface TextProps extends NativeTextProps {
  variant?: TypeVariant
  tone?: TextTone
  align?: 'center' | 'left' | 'right'
}

const TONES: Record<TextTone, keyof Palette> = {
  accent: 'accent',
  danger: 'danger',
  faint: 'faint',
  muted: 'muted',
  onInk: 'onInk',
  text: 'text'
}

/** Text in one of the scale's styles. Scales with Dynamic Type, capped so layouts hold. */
export function Text({ align, style, tone = 'text', variant = 'body', ...rest }: TextProps) {
  const theme = useTheme()

  return (
    <NativeText
      maxFontSizeMultiplier={1.6}
      {...rest}
      style={[scale[variant], { color: theme[TONES[tone]] as string, textAlign: align }, style]}
    />
  )
}
