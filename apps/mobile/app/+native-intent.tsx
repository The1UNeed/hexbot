/**
 * Links into the app (`hexbot://pair`, `hexbot://bot`, Hex Connect's callback,
 * `hexbot://demo`) are not screens: the app reads them itself (`App.tsx`) and
 * opens what they name, so the router starts at the chat list for them.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  return path.startsWith('/') && !path.startsWith('//') ? path : '/'
}
