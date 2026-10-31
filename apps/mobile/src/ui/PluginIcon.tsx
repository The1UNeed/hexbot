import { Ionicons } from '@expo/vector-icons'
import { StyleSheet, View } from 'react-native'
import Svg, { Path } from 'react-native-svg'

import { BRAND_ICONS } from '../../../web/src/lib/connector-icons'

import { useTheme } from './theme'

type IconName = keyof typeof Ionicons.glyphMap

/** The web app's lucide glyphs (`glyph:<name>`), as the nearest Ionicon. */
const GLYPHS: Record<string, IconName> = {
  'at-sign': 'at-outline',
  'book-open': 'book-outline',
  bot: 'hardware-chip-outline',
  bug: 'bug-outline',
  'calendar-check': 'calendar-outline',
  'chart-pie': 'pie-chart-outline',
  clapperboard: 'videocam-outline',
  'clipboard-check': 'clipboard-outline',
  code: 'code-slash-outline',
  'file-spreadsheet': 'grid-outline',
  'file-text': 'document-text-outline',
  'file-type': 'document-outline',
  film: 'film-outline',
  flask: 'flask-outline',
  'folder-search': 'folder-open-outline',
  'git-pull-request': 'git-pull-request-outline',
  globe: 'globe-outline',
  hexagon: 'cube-outline',
  image: 'image-outline',
  inbox: 'file-tray-outline',
  'layout-template': 'albums-outline',
  'list-checks': 'checkbox-outline',
  mail: 'mail-outline',
  monitor: 'desktop-outline',
  music: 'musical-notes-outline',
  network: 'git-network-outline',
  newspaper: 'newspaper-outline',
  notebook: 'journal-outline',
  package: 'cube-outline',
  palette: 'color-palette-outline',
  'pen-line': 'create-outline',
  presentation: 'easel-outline',
  quote: 'chatbox-ellipses-outline',
  'scan-search': 'scan-outline',
  scissors: 'cut-outline',
  search: 'search-outline',
  server: 'server-outline',
  'server-cog': 'cog-outline',
  'shield-alert': 'shield-outline',
  sparkles: 'sparkles-outline',
  'square-terminal': 'terminal-outline',
  tag: 'pricetag-outline',
  users: 'people-outline',
  wand: 'color-wand-outline',
  wrench: 'construct-outline'
}

/** A plugin's icon, as the web app draws it: a brand on its colour, or a plain glyph. */
export function PluginIcon({ icon }: { icon: string }) {
  const theme = useTheme()
  const brand = BRAND_ICONS[icon]

  if (brand) {
    return (
      <View style={[styles.box, { backgroundColor: brand.color }]}>
        <Svg fill="#ffffff" height={16} viewBox="0 0 24 24" width={16}>
          <Path d={brand.path} />
        </Svg>
      </View>
    )
  }

  return (
    <View style={[styles.box, { backgroundColor: theme.fill }]}>
      <Ionicons
        color={theme.text}
        name={GLYPHS[icon.replace(/^glyph:/, '')] ?? 'server-outline'}
        size={16}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', borderRadius: 8, height: 28, justifyContent: 'center', width: 28 }
})
