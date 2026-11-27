// Pick the build for the visitor's computer from what the browser reveals.
// Chromium says the CPU through User-Agent Client Hints; Safari and Firefox
// do not, so the WebGL renderer string stands in: Apple Silicon Macs report
// an Apple GPU, Intel Macs an Intel, AMD, or NVIDIA one. When nothing is
// known, Apple Silicon is the better guess for a Mac sold since 2020.
// iPhones and iPads get the iPhone app, which pairs with a daemon elsewhere.
export type Target = 'mac-arm64' | 'mac-x64' | 'linux' | 'win-x64' | 'ios' | 'other'

export type Environment = {
  userAgent: string
  maxTouchPoints?: number
  architecture?: string
  bitness?: string
  renderer?: string
}

export function detectTarget({ userAgent, maxTouchPoints = 0, architecture, bitness, renderer }: Environment): Target {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios'
  if (/Windows/i.test(userAgent)) {
    if (/arm|aarch64/i.test(`${architecture ?? ''} ${userAgent}`)) return 'other'
    return (architecture === 'x86' && bitness === '64') || /Win64|x64|WOW64/i.test(userAgent) ? 'win-x64' : 'other'
  }
  if (/Android|CrOS/i.test(userAgent)) return 'other'
  if (/Macintosh|Mac OS X/.test(userAgent)) {
    if (maxTouchPoints > 1) return 'ios' // iPadOS calls itself a Mac
    if (architecture === 'arm') return 'mac-arm64'
    if (architecture === 'x86') return 'mac-x64'
    if (renderer) return /Apple (M\d|GPU)|\(Apple,/.test(renderer) ? 'mac-arm64' : 'mac-x64'
    return 'mac-arm64'
  }
  if (/Linux|X11/.test(userAgent)) return 'linux'
  return 'other'
}
