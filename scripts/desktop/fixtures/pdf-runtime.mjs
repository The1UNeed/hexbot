import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export async function pdfFixture(directory, { arch = 'arm64', helper = true, release = false } = {}) {
  await mkdir(directory, { recursive: true })
  const architecture = arch === 'arm64' ? 'aarch64' : 'x86_64'
  const files = {}
  for (const name of ['kernel', 'initramfs', 'rootfs']) {
    await writeFile(join(directory, name), name)
    files[name] = sha(name)
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ version: 1, architecture, files }))
  await writeFile(join(directory, 'kernel.provenance.json'), '{}')
  await writeFile(join(directory, 'THIRD_PARTY_NOTICES'), release ? 'complete guest notices' : 'INCOMPLETE development prototype notices')
  const archiveBytes = Buffer.from('source archive fixture')
  const archive = { file: 'pdf-sources-1.2.3.tar.gz', bytes: archiveBytes.length, sha256: sha(archiveBytes),
    url: 'https://updates.hexbot.app/daemon/native/1.2.3/macos-aarch64/pdf-sources-1.2.3.tar.gz' }
  const provenance = { version: 1, architecture, status: release ? 'release-ready' : 'prototype-not-release-ready',
    sourceArchiveComplete: release, noticesComplete: release, sourceArchive: release ? archive : null }
  const sources = { version: 1, architecture, completeCorrespondingSourceArchive: release, archive: release ? archive : null }
  await writeFile(join(directory, 'PROVENANCE.json'), JSON.stringify(provenance))
  await writeFile(join(directory, 'SOURCES.json'), JSON.stringify(sources))
  if (helper) {
    const binary = Buffer.alloc(16)
    binary.writeUInt32LE(0xfeedfacf)
    binary.writeUInt32LE(arch === 'arm64' ? 0x100000c : 0x1000007, 4)
    await writeFile(join(directory, 'hexbot-pdf-vm'), binary)
    await chmod(join(directory, 'hexbot-pdf-vm'), 0o755)
  }
  const runtimeFiles = {}
  for (const name of await readdir(directory)) runtimeFiles[`pdf/${name}`] = sha(await readFile(join(directory, name)))
  return { provenance, sources, archiveBytes, archive, runtimeFiles }
}
