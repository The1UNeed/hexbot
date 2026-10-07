import Svg, { Path, Rect } from 'react-native-svg'

import { useTheme } from '../theme'

const HEXAGON =
  'M44 6a12 12 0 0 1 12 0l30 17a12 12 0 0 1 6 10v34a12 12 0 0 1-6 10L56 94a12 12 0 0 1-12 0L14 77a12 12 0 0 1-6-10V33a12 12 0 0 1 6-10Z'

/** The Hexbot mark: the hexagon face with two tall eyes, in the foreground colour. */
export function HexbotMark({ size }: { size: number }) {
  const { colors } = useTheme()

  return (
    <Svg accessibilityLabel="Hexbot" height={size} viewBox="0 0 100 100" width={size}>
      <Path d={HEXAGON} fill={colors.text} />
      <Rect fill={colors.bg} height={36} rx={7.5} width={15} x={25} y={33} />
      <Rect fill={colors.bg} height={36} rx={7.5} width={15} x={60} y={33} />
    </Svg>
  )
}
