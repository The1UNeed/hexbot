// Stage the pinned BusyBox as <directory>/busybox.exe, checked as the Windows
// runtime checks it. CI puts it beside the daemon it tests, where the daemon
// looks for its shell (`bin\busybox.exe` beside the helper). It comes from
// HEXBOT_BUSYBOX_FILE when that names a copy, otherwise from the build cache
// (node_modules/.cache/hexbot), which downloads it only when it has no good copy.
//   node scripts/desktop/stage-busybox.mjs <directory>
import { resolve } from 'node:path'
import { stageBusybox } from './native-runtime.mjs'

const [directory, ...extra] = process.argv.slice(2)
if (!directory || extra.length) {
  console.error('Usage: node scripts/desktop/stage-busybox.mjs <directory>')
  process.exit(2)
}
console.log(await stageBusybox(resolve(directory), { file: process.env.HEXBOT_BUSYBOX_FILE || undefined }))
