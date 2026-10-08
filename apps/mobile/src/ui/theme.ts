import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useSyncExternalStore
} from 'react'
import { AccessibilityInfo, Platform, useColorScheme } from 'react-native'

/**
 * Colours for one appearance. Content sits on solid colour; only the floating
 * controls (tab bar, composer, header buttons) use glass, and they fall back
 * to `chrome` when glass is unavailable or Reduce Transparency is on.
 */
export interface Palette {
  scheme: 'dark' | 'light'
  /** Screen background. */
  background: string
  /** Background behind grouped form sections. */
  grouped: string
  /** Grouped rows, cards and sheets. */
  surface: string
  /** Bot bubbles, input wells, secondary buttons. */
  fill: string
  /** Pressed state on rows. */
  pressed: string
  /** The selected segment, lifted off a fill. */
  raised: string
  text: string
  /** Previews, timestamps, footnotes. At least 4.5:1 on `background`. */
  muted: string
  /** Placeholders and disabled labels only. */
  faint: string
  hairline: string
  accent: string
  onAccent: string
  /** The user's own bubble and the primary button. */
  ink: string
  onInk: string
  danger: string
  info: string
  success: string
  warning: string
  /** Solid stand-in for glass. */
  chrome: string
  chromeBorder: string
  /** Inner block inside a bubble, such as a command in an approval card. */
  inset: string
}

const light: Palette = {
  accent: '#4f46e5',
  background: '#ffffff',
  chrome: 'rgba(250, 250, 252, 0.96)',
  chromeBorder: 'rgba(0, 0, 0, 0.08)',
  danger: '#d92d20',
  faint: '#a1a1a6',
  fill: '#f0f0f2',
  grouped: '#f2f2f7',
  hairline: '#e3e3e8',
  info: '#2f7cf6',
  ink: '#141414',
  inset: '#ffffff',
  muted: '#6b6b70',
  onAccent: '#ffffff',
  onInk: '#ffffff',
  pressed: '#ececef',
  raised: '#ffffff',
  scheme: 'light',
  success: '#16a34a',
  surface: '#ffffff',
  text: '#141414',
  warning: '#b54708'
}

const dark: Palette = {
  accent: '#8b85ff',
  background: '#000000',
  chrome: 'rgba(28, 28, 30, 0.96)',
  chromeBorder: 'rgba(255, 255, 255, 0.1)',
  danger: '#f4645b',
  faint: '#636366',
  fill: '#2a2a2d',
  grouped: '#000000',
  hairline: '#38383a',
  info: '#4c9aff',
  ink: '#f4f4f4',
  inset: '#121214',
  muted: '#a1a1a6',
  onAccent: '#0e0e0e',
  onInk: '#141414',
  pressed: '#333336',
  raised: '#48484b',
  scheme: 'dark',
  success: '#34c759',
  surface: '#1c1c1e',
  text: '#f4f4f4',
  warning: '#f7b24a'
}

export const palettes = { dark, light }

/**
 * One type scale, close to the iOS text styles so it sits well next to
 * system controls. Sizes are points and scale with Dynamic Type.
 */
export const type = {
  largeTitle: { fontSize: 32, fontWeight: '700', letterSpacing: 0.2, lineHeight: 38 },
  title: { fontSize: 22, fontWeight: '700', lineHeight: 28 },
  headline: { fontSize: 17, fontWeight: '600', lineHeight: 22 },
  body: { fontSize: 17, fontWeight: '400', lineHeight: 23 },
  callout: { fontSize: 15, fontWeight: '400', lineHeight: 20 },
  subhead: { fontSize: 15, fontWeight: '600', lineHeight: 20 },
  footnote: { fontSize: 13, fontWeight: '400', lineHeight: 18 },
  caption: { fontSize: 12, fontWeight: '500', lineHeight: 16 }
} as const

export type TypeVariant = keyof typeof type

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const

/** Radii by role: controls are capsules, bubbles round, panels softer. */
export const radius = { bubble: 20, card: 18, field: 14, panel: 24, pill: 999 } as const

/** Smallest touch target, in points. */
export const HIT = 44

export const mono = Platform.select({ android: 'monospace', default: 'Menlo' })

// Reduce Transparency is iOS-only and changes rarely, so one shared listener
// feeds every component instead of one per glass surface.
let reduceTransparency = false
let listening = false
const listeners = new Set<() => void>()

function setReduceTransparency(value: boolean) {
  if (value === reduceTransparency) {
    return
  }

  reduceTransparency = value
  listeners.forEach(listener => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)

  if (!listening && Platform.OS === 'ios') {
    listening = true
    void AccessibilityInfo.isReduceTransparencyEnabled().then(setReduceTransparency)
    AccessibilityInfo.addEventListener('reduceTransparencyChanged', setReduceTransparency)
  }

  return () => {
    listeners.delete(listener)
  }
}

export function useReduceTransparency() {
  return useSyncExternalStore(
    subscribe,
    () => reduceTransparency,
    () => false
  )
}

export interface Theme extends Palette {
  reduceTransparency: boolean
}

const SchemeContext = createContext<'dark' | 'light' | null>(null)

/** Forces an appearance for everything below it; leave it out to follow the system. */
export function ThemeProvider({
  children,
  scheme
}: {
  children: ReactNode
  scheme?: 'dark' | 'light' | null
}) {
  return createElement(SchemeContext.Provider, { value: scheme ?? null }, children)
}

export function useTheme(): Theme {
  const forced = useContext(SchemeContext)
  const system = useColorScheme()
  const reduce = useReduceTransparency()
  const scheme = forced ?? (system === 'dark' ? 'dark' : 'light')

  return { ...palettes[scheme], reduceTransparency: reduce }
}
