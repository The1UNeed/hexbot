import { useEffect, useState } from 'react'
import { Keyboard, Platform } from 'react-native'

import { useCovered } from './Layer'

/**
 * Whether the software keyboard is up, so bars can step out of its way. A
 * card or sheet over the screen owns the keyboard; the bars under it stay put.
 */
export function useKeyboardVisible() {
  const [visible, setVisible] = useState(false)
  const covered = useCovered()

  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setVisible(true)
    )
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setVisible(false)
    )

    return () => {
      show.remove()
      hide.remove()
    }
  }, [])

  return visible && !covered
}
