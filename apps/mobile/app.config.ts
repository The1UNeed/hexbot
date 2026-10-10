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
  plugins: ['expo-secure-store', 'expo-font', 'expo-web-browser', ['./plugins/local-network.cjs']],
  web: { bundler: 'metro' }
}
export default config
