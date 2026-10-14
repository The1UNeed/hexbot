import type { ExpoConfig } from 'expo/config'

const config: ExpoConfig = {
  icon: './assets/icon.png',
  backgroundColor: '#ffffff',
  name: 'Hexbot',
  slug: 'hexbot-mobile',
  version: '0.1.0',
  scheme: 'hexbot',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: 'app.hexbot.mobile',
    supportsTablet: true,
    infoPlist: {
      NSLocalNetworkUsageDescription: 'Hexbot connects to your daemons on your local network.',
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true, NSAllowsArbitraryLoads: true },
      ITSAppUsesNonExemptEncryption: false
    }
  },
  android: {
    package: 'app.hexbot.mobile',
    predictiveBackGestureEnabled: true,
    permissions: ['INTERNET', 'ACCESS_NETWORK_STATE']
  },
  plugins: [
    'expo-secure-store',
    'expo-font',
    'expo-web-browser',
    'expo-notifications',
    ['./plugins/local-network.cjs']
  ],
  // Push for check-ins needs the app's EAS project; without one the app skips it.
  extra: process.env.EAS_PROJECT_ID ? { eas: { projectId: process.env.EAS_PROJECT_ID } } : {},
  web: { bundler: 'metro' }
}
export default config
