import { once } from 'node:events'

/** Keep handling forwarded and repeated signals until asynchronous cleanup finishes. */
export function retainUntilStopped() {
  let stop
  const stopped = new Promise(resolve => { stop = resolve })
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  return {
    stopped,
    dispose() {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
    }
  }
}

export async function stopChild(child) {
  // A process-group interrupt may already have reaped the daemon by signal.
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  await exited
}
