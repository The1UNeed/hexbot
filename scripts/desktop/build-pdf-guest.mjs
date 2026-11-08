// Run only the guest build in a bounded, owned native Linux container.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { pdfFileHash, validatePdfRelease, validatePdfRuntime } from './pdf-runtime.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const execute = promisify(execFile)
// Authenticated Rust 1.97.1 index and its Linux AMD64 child. The Intel pin
// enables native build qualification; it does not establish guest execution.
const images = {
  aarch64: 'rust@sha256:b1b3c9c0d921d7fa0a6d1f9ec7e4eab87f8c8ec97644c3d791450f131dec813f',
  x86_64: 'rust@sha256:4277ce860337f6cfa1b679891bbf689a447f4b3f4f55701742614ad31321cee7'
}
const build = 'set -eu\nguest=/work/backend/pdf-runtime/guest\n' +
  'apt-get update\napt-get install -y --no-install-recommends musl-tools e2fsprogs cpio xz-utils python3 curl ca-certificates gpg\n' +
  'rustup target add "$HEXBOT_PDF_ARCH-unknown-linux-musl"\n' +
  'python3 "$guest/build-assets.py" --arch "$HEXBOT_PDF_ARCH" --cache /pdf-cache --out /pdf-built --kernel-config-out /pdf-kernel.config\n' +
  'if [ "$HEXBOT_PDF_CHANNEL" = dev ]; then\n  mv /pdf-built /pdf-assets\nelse\n' +
  '  python3 "$guest/collect-sources.py" --arch "$HEXBOT_PDF_ARCH" --out /pdf-sources --version "$HEXBOT_PDF_VERSION" ' +
  '--url-base "https://updates.hexbot.app/daemon/native/$HEXBOT_PDF_VERSION/macos-$HEXBOT_PDF_ARCH" ' +
  '--kernel-config /pdf-kernel.config --require-rust-signatures\n' +
  '  archive=$(python3 -c \'import json; print("/pdf-sources/" + json.load(open("/pdf-sources/SOURCES.json"))["archive"]["file"])\')\n' +
  '  python3 "$guest/finalize-assets.py" --assets /pdf-built --sources /pdf-sources/SOURCES.json --notices /pdf-sources/THIRD_PARTY_NOTICES ' +
  '--archive "$archive" --lock "$guest/assets.lock.json" --arch "$HEXBOT_PDF_ARCH" --version "$HEXBOT_PDF_VERSION" --out /pdf-assets\nfi\n'

export async function buildPdfGuest({ repository = root, architecture, output, channel = 'dev', version,
  sourceArchivePath = process.env.HEXBOT_PDF_SOURCE_ARCHIVE, platform = process.platform, hostArch = process.arch,
  run = (command, args, options) => execute(command, args, { ...options, maxBuffer: 64 * 1024 * 1024 }) }) {
  const arch = { aarch64: 'arm64', x86_64: 'x64' }[architecture]
  if (!['dev', 'stable', 'nightly'].includes(channel)) throw new Error('Unsupported PDF guest build channel')
  if (channel !== 'dev' && (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)))
    throw new Error('A release version is required for the immutable PDF source companion URL')
  if (platform !== 'linux' || hostArch !== arch) throw new Error('PDF guest builds require a matching native Linux builder')
  const guest = join(repository, 'backend/pdf-runtime/guest')
  const lock = JSON.parse(await readFile(join(guest, 'assets.lock.json'), 'utf8'))
  if (!images[architecture] || !lock.architectures?.[architecture]?.packages?.length)
    throw new Error(`PDF guest ${architecture} has no complete reviewed package lock and native builder image`)
  if (channel !== 'dev' && lock.status !== 'release-ready')
    throw new Error('The PDF VM package/source lock is a prototype; release artifacts cannot be produced yet')
  const scratch = await mkdtemp(join(tmpdir(), 'hexbot-pdf-source-'))
  const container = `hexbot-pdf-build-${randomUUID()}`
  let created = false
  try {
    const source = join(scratch, 'repository')
    const runtime = join(repository, 'backend/pdf-runtime')
    await mkdir(join(source, 'backend'), { recursive: true })
    await cp(runtime, join(source, 'backend/pdf-runtime'), { recursive: true, filter: path =>
      !relative(runtime, path).split(/[\\/]/).some(part => ['target', '.git', '.build', '.swiftpm', '.venv', '__pycache__', 'assets', 'out'].includes(part)) })
    for (const file of ['LICENSE', 'NOTICE']) await cp(join(repository, file), join(source, file))
    await run('docker', ['create', '--name', container, '--memory', '6g', '--memory-swap', '6g',
      '--cpus', '2', '--pids-limit', '256', '--ulimit', 'core=0', '--security-opt', 'no-new-privileges',
      '--env', `HEXBOT_PDF_ARCH=${architecture}`, '--env', `HEXBOT_PDF_CHANNEL=${channel}`,
      '--env', `HEXBOT_PDF_VERSION=${version ?? ''}`, images[architecture], '/bin/sh', '-c', build])
    created = true
    await run('docker', ['cp', `${source}/.`, `${container}:/work`])
    await run('docker', ['start', '--attach', container], { timeout: 40 * 60 * 1000 })
    const status = await run('docker', ['inspect', '--format', '{{.State.ExitCode}}', container])
    if (status.stdout.trim() !== '0') throw new Error('The native PDF guest builder failed')
    await mkdir(output, { recursive: true })
    const assets = join(output, 'assets')
    await run('docker', ['cp', `${container}:/pdf-assets`, assets])
    const checked = await validatePdfRuntime(assets, arch, { helper: false })
    if (channel !== 'dev') {
      if (!sourceArchivePath && checked.sources.completeCorrespondingSourceArchive === true) {
        const file = checked.sources.archive?.file
        if (typeof file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(file))
          throw new Error('The PDF source companion filename is invalid')
        sourceArchivePath = join(output, file)
        await run('docker', ['cp', `${container}:/pdf-sources/${file}`, sourceArchivePath])
      }
      const archive = await validatePdfRelease(checked, { version, sourceArchivePath,
        verifySources: archive => run('python3', [join(guest, 'verify-sources.py'), '--archive', archive,
          '--sources', join(assets, 'SOURCES.json'), '--notices', join(assets, 'THIRD_PARTY_NOTICES'),
          '--lock', join(guest, 'assets.lock.json'), '--arch', architecture, '--version', version]) })
      if (resolve(sourceArchivePath) !== resolve(join(output, archive.file)))
        await cp(sourceArchivePath, join(output, archive.file))
      if (await pdfFileHash(join(output, archive.file), archive.bytes) !== archive.sha256)
        throw new Error('The PDF source companion changed while being copied')
    }
    return { assets, architecture, status: checked.provenance.status }
  } finally {
    try { if (created) await run('docker', ['rm', '--force', container]) }
    finally { await rm(scratch, { recursive: true, force: true }) }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [architecture, output, channel = 'dev', version] = process.argv.slice(2)
  if (!architecture || !output) throw new Error('Usage: node build-pdf-guest.mjs aarch64|x86_64 OUTPUT [dev|stable|nightly] [VERSION]')
  console.log(await buildPdfGuest({ architecture, output: resolve(output), channel, version }))
}
