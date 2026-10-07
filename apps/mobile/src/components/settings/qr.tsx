import qrcode from 'qrcode-generator'
import { useMemo } from 'react'
import Svg, { Path, Rect } from 'react-native-svg'

/**
 * A QR code drawn as one SVG path. Always dark on white with a quiet zone,
 * in both themes, so any camera reads it.
 */
export function QrCode({ size, value }: { size: number; value: string }) {
  const { count, path } = useMemo(() => {
    const code = qrcode(0, 'M')
    code.addData(value)
    code.make()

    const modules = code.getModuleCount()
    let d = ''

    for (let row = 0; row < modules; row += 1) {
      for (let col = 0; col < modules; col += 1) {
        if (code.isDark(row, col)) {
          d += `M${col + QUIET} ${row + QUIET}h1v1h-1z`
        }
      }
    }

    return { count: modules + QUIET * 2, path: d }
  }, [value])

  return (
    <Svg accessibilityLabel="Pairing QR code" height={size} viewBox={`0 0 ${count} ${count}`} width={size}>
      <Rect fill="#FFFFFF" height={count} rx={2} width={count} />
      <Path d={path} fill="#000000" />
    </Svg>
  )
}

const QUIET = 2
