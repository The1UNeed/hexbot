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

export function iconOptions(channel, iconComposer) {
  if (channel === 'dev') return [
    `-c.mac.icon=${iconComposer ? '../../icon-dev.icon' : 'build/icon-dev.icns'}`,
    '-c.linux.icon=resources/icon-dev.png'
  ]
  return iconComposer ? ['-c.mac.icon=build/Hexbot.icon'] : []
}
