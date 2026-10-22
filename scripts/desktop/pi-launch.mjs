// Windows runs Pi through Node, without cmd.exe argument expansion.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareSearchTools } from './search-tools.mjs'
const root = dirname(fileURLToPath(import.meta.url))
if (!process.argv.includes('--version'))
  await prepareSearchTools(join(root, '..', 'bin'), process.env.PI_CODING_AGENT_DIR)
await import('./node_modules/@earendil-works/pi-coding-agent/dist/cli.js')
