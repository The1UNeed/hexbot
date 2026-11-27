import type { ExpoConfig } from 'expo/config'

const config: ExpoConfig = {
  icon: './assets/icon.png',
  backgroundColor: '#ffffff',
  name: 'Hexbot',
  slug: 'hexbot-mobile',
  owner: 'the1uneed',
  extra: {
    eas: { projectId: '3d292b3c-aaff-4a09-927a-9d143e90c7c7' }
  },
  version: '0.1.0',
  scheme: 'hexbot',
  // Every orientation: phones turn sideways, and a foldable opens to a wide screen.
  orientation: 'default',
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
    'expo-router',
    'expo-secure-store',
    'expo-font',
    'expo-web-browser',
    'expo-notifications',
    [
      'expo-image-picker',
      {
        photosPermission: 'Hexbot sends the photos and videos you choose to your bots.',
        cameraPermission: 'Hexbot takes photos and videos to send to your bots.',
        microphonePermission: 'Hexbot records sound with the videos you take for your bots.'
      }
    ],
    ['./plugins/local-network.cjs']
  ],
  web: { bundler: 'metro' }
}
export default config
