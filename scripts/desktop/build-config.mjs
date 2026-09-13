export function parseBuildArgs(args) {
  const client = args.includes('--client')
  const channelIndex = args.indexOf('--channel')
  const channel = channelIndex === -1 ? 'dev' : args[channelIndex + 1]
  if (!['stable', 'nightly', 'dev'].includes(channel))
    throw new Error(`Unknown channel "${channel}". Use stable, nightly, or dev.`)
  const builderArgs = args.filter(
    (arg, i) => arg !== '--client' && arg !== '--channel' && (channelIndex === -1 || i !== channelIndex + 1)
  )
  return { client, channel, builderArgs }
}

// Stable uses electron-builder's defaults (build/icon.icns, build/icon.png).
// Nightly and Dev carry their own Icon Composer bundle in apps/desktop/build
// with fallbacks compiled by make-channel-icons.mjs.
export function iconOptions(channel, iconComposer) {
  if (channel === 'stable') return iconComposer ? ['-c.mac.icon=build/Hexbot.icon'] : []
  return [
    `-c.mac.icon=build/icon-${channel}.${iconComposer ? 'icon' : 'icns'}`,
    `-c.linux.icon=resources/icon-${channel}.png`
  ]
}
