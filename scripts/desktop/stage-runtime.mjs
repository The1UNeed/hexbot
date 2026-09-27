// Stage Rust by default; HEXBOT_BACKEND=python retains the rollback build.
import { selectBackend } from './backend-selection.mjs'
const backend = selectBackend()
if (backend === 'rust') {
  const { stageNativeRuntime } = await import('./native-runtime.mjs')
  const result = await stageNativeRuntime()
  console.log(`Staged Hexbot ${result.version} native runtime for ${result.target}`)
} else if (backend === 'python') {
  await import('./stage-python-src.mjs')
} else {
  throw new Error(`Unknown backend "${backend}". Use python or rust.`)
}
