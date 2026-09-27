export function selectBackend(args = [], env = process.env) {
  const index = args.indexOf('--backend')
  const backend = index === -1 ? env.HEXBOT_BACKEND || 'rust' : args[index + 1]
  if (!['rust', 'python'].includes(backend)) throw new Error('Use --backend rust or --backend python')
  return backend
}

export function builderConfig(backend, client) {
  if (client) return ['--config', 'electron-builder.client.yml']
  return backend === 'python' ? ['--config', 'electron-builder.python.yml'] : []
}

export function nativeBuildEnvironment(args, platform = process.platform, arch = process.arch) {
  if (args.filter(arg => arg === '--mac' || arg === '--linux').length !== 1 ||
      args.includes('--universal') || (args.includes('--arm64') && args.includes('--x64')))
    throw new Error('Build one native platform and architecture at a time')
  const targetPlatform = args.includes('--mac') ? 'darwin' : 'linux'
  const targetArch = args.includes('--arm64') ? 'arm64' : args.includes('--x64') ? 'x64' : arch
  if (targetPlatform !== platform || targetArch !== arch)
    throw new Error(`Native packages need a ${targetPlatform}/${targetArch} runner`)
  return { HEXBOT_BUILD_PLATFORM: targetPlatform, HEXBOT_BUILD_ARCH: targetArch }
}
