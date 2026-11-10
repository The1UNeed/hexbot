/**
 * For tests that change process.env: puts the saved variables back into the
 * real object. Replacing process.env with the copy would leave an object that
 * looks names up with case, and Windows names such as SystemRoot would go
 * missing for every later test.
 */
export function restoreEnvironment(saved: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]
  Object.assign(process.env, saved)
}
