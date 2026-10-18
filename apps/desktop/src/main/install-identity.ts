import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const idPattern = /^app\.hexbot\.(desktop|client)(\.(nightly|dev))?$/

/** The install track stays fixed when Settings switches the payload's update track. */
export function parseInstallIdentity(bytes: Buffer, buildId: string): string {
  const text = bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))
    ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8').replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (bytes.length > 1024 || lines.length !== 2 || lines[0] !== '[installation]' || !lines[1]?.startsWith('appId='))
    throw new Error('Cannot identify this Hexbot installation. Run the Hexbot Installer to repair it.')
  const id = lines[1].slice('appId='.length)
  const initial = idPattern.exec(id), build = idPattern.exec(buildId)
  if (!initial || !build || initial[1] !== build[1] || (initial[3] === 'dev' || build[3] === 'dev') && id !== buildId)
    throw new Error('The Hexbot installation identity does not match this app.')
  return id
}

export async function readInstallIdentity(executable = process.execPath, buildId = __HEXBOT_APP_ID__): Promise<string> {
  try { return parseInstallIdentity(await readFile(join(dirname(executable), 'hexbot-install.ini')), buildId) }
  catch (error) {
    // Unpacked developer and packaging probes have not run the NSIS installer.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return buildId
    throw error
  }
}
