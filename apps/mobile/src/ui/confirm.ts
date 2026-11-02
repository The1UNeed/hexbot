import { Alert, Platform } from 'react-native'

/** Asks before an action that cannot be undone; the action's button is the title. */
export function confirm(title: string, body: string, action: () => void) {
  if (Platform.OS === 'web') {
    // React Native Web has no Alert, so the browser preview asks with the browser's dialog.
    if (globalThis.confirm?.(`${title}. ${body}`) ?? true) action()
    return
  }
  Alert.alert(title, body, [
    { text: 'Cancel', style: 'cancel' },
    { text: title, style: 'destructive', onPress: action }
  ])
}
