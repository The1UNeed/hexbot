import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { prepareDevElectron } from './electron-launcher.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const desktop = join(root, 'apps/desktop')
const require = createRequire(join(desktop, 'package.json'))
// GUI terminals and coding tools may pass this through from their own Electron
// runtime. The desktop child must start as an app.
delete process.env.ELECTRON_RUN_AS_NODE
process.env.ELECTRON_EXEC_PATH = await prepareDevElectron()
process.env.HEXBOT_HOME ||= join(root, '.hexbot')
process.env.HEXBOT_CHANNEL = 'dev'
process.chdir(desktop)
// electron-vite owns the child process and its hot-reload lifecycle.
await import(pathToFileURL(join(dirname(require.resolve('electron-vite/package.json')), 'bin/electron-vite.js')).href)
