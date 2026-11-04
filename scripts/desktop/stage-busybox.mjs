// Stage the pinned BusyBox as <directory>/busybox.exe, checked as the Windows
// runtime checks it. CI puts it beside the daemon it tests, where the daemon
// looks for its shell (`bin\busybox.exe` beside the helper).
//   node scripts/desktop/stage-busybox.mjs <directory>
import { resolve } from 'node:path'
import { stageBusybox } from './native-runtime.mjs'

const [directory] = process.argv.slice(2)
if (!directory) {
  console.error('Usage: node scripts/desktop/stage-busybox.mjs <directory>')
  process.exit(2)
}
console.log(await stageBusybox(resolve(directory)))
