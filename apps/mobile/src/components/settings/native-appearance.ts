import { useEffect } from 'react'
import { Appearance } from 'react-native'

import { type ThemePreference, useUi } from '../../stores/ui'

/**
 * Make native chrome (headers, glass, alerts, the keyboard, the search bar)
 * follow the theme chosen in Settings, Appearance. System hands the choice
 * back to the phone.
 */
export function applyNativeAppearance(theme: ThemePreference): void {
  Appearance.setColorScheme(theme === 'system' ? 'unspecified' : theme)
}

/** Mount once near the root so the saved choice applies at launch. */
export function useNativeAppearance(): void {
  const theme = useUi(state => state.theme)

  useEffect(() => applyNativeAppearance(theme), [theme])
}
