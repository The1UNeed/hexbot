import { stageNativeRuntime } from './native-runtime.mjs'
const result = await stageNativeRuntime()
console.log(`Staged Hexbot ${result.version} native runtime for ${result.target}`)
