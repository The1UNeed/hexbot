export function nativeBuildEnvironment(args, platform = process.platform, arch = process.arch) {
  if (args.filter(arg => arg === '--mac' || arg === '--linux' || arg === '--win').length !== 1 ||
      args.includes('--universal') || (args.includes('--arm64') && args.includes('--x64')))
    throw new Error('Build one native platform and architecture at a time')
  const targetPlatform = args.includes('--mac') ? 'darwin' : args.includes('--win') ? 'win32' : 'linux'
  const targetArch = args.includes('--arm64') ? 'arm64' : args.includes('--x64') ? 'x64' : arch
  if (targetPlatform === 'win32' && targetArch !== 'x64')
    throw new Error('Windows packages are x64 only')
  if (targetPlatform !== platform || (targetArch !== arch && !(platform === 'darwin' && arch === 'arm64' && targetArch === 'x64')))
    throw new Error(`Native packages need a ${targetPlatform}/${targetArch} runner`)
  return { HEXBOT_BUILD_PLATFORM: targetPlatform, HEXBOT_BUILD_ARCH: targetArch }
}
