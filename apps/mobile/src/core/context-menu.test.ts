import { describe, expect, it, vi } from 'vitest'

import { menuPlace } from '../ui/ContextMenu'

vi.mock('react-native', () => ({
  AccessibilityInfo: {},
  Animated: {},
  Easing: {},
  Modal: () => null,
  Platform: { OS: 'ios' },
  Pressable: () => null,
  StyleSheet: { absoluteFill: {}, create: (styles: unknown) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ height: 0, width: 0 }),
  View: () => null
}))
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }))
vi.mock('expo-blur', () => ({ BlurView: () => null }))
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({}) }))
vi.mock('../ui/Glass', () => ({ Glass: () => null, glassMaterial: 'solid' }))
vi.mock('../ui/Text', () => ({ Text: () => null }))
vi.mock('../ui/theme', () => ({ useTheme: () => ({}) }))

/** The menu's top and bottom edges on a screen of this height. */
const edges = (place: ReturnType<typeof menuPlace>['place'], height: number, screen: number) =>
  'top' in place
    ? { bottom: place.top + height, top: place.top }
    : { bottom: screen - place.bottom, top: screen - place.bottom - height }

describe('long-press menu placement', () => {
  const height = 4 * 46 + 8

  it('opens under a row with room below it, as before', () => {
    const { downward, place } = menuPlace({ h: 72, w: 360, x: 16, y: 200 }, height, 844, {
      bottom: 34,
      top: 47
    })
    expect(downward).toBe(true)
    expect(place).toEqual({ top: 282 })
  })

  it('stays on screen beside a row in the middle of a landscape phone', () => {
    const insets = { bottom: 21, top: 0 }
    const { place } = menuPlace({ h: 72, w: 700, x: 16, y: 150 }, height, 390, insets)
    const { bottom, top } = edges(place, height, 390)
    expect(top).toBeGreaterThanOrEqual(insets.top)
    expect(bottom).toBeLessThanOrEqual(390 - insets.bottom)
  })
})
