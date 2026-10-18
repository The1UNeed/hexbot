// Set the edition without relying on the host shell's environment syntax.
import { build } from 'electron-vite'
process.env.HEXBOT_EDITION = 'client'
await build()
