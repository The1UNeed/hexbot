export const Platform = { OS: 'ios', select: <T,>(options: { default?: T; ios?: T }) => options.ios ?? options.default }
export const AppState = { addEventListener: () => ({ remove: () => undefined }), currentState: 'active' }
export const Appearance = { getColorScheme: () => 'light', setColorScheme: () => undefined }
