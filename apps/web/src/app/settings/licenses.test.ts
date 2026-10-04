import cargo from '../../../../../backend/hexbot-core/Cargo.toml?raw'
import pi from '../../../../../backend/pi-runtime/package.json'
import desktop from '../../../../desktop/package.json'
import web from '../../../package.json'

import { OPEN_SOURCE } from './licenses'

const credited = new Set(
  OPEN_SOURCE.flatMap(group => group.projects.flatMap(project => project.packages ?? []))
)

/** Crate names from every `[dependencies]` table, including target-specific ones. */
function crates(toml: string): string[] {
  const names: string[] = []
  let inDependencies = false

  for (const line of toml.split('\n')) {
    const table = /^\[(.+)\]\s*$/.exec(line)?.[1]

    if (table) {
      inDependencies = /(^|\.)dependencies$/.test(table) && !table.includes('dev-')
    } else if (inDependencies) {
      const name = /^([A-Za-z0-9_-]+)\s*=/.exec(line)

      if (name?.[1]) {
        names.push(name[1])
      }
    }
  }

  return names
}

it('credits every shipped dependency', () => {
  const shipped = [
    ...crates(cargo),
    ...Object.keys(pi.dependencies),
    ...Object.keys(desktop.dependencies),
    'electron',
    ...Object.keys(web.dependencies).filter(name => !name.startsWith('@hermes/'))
  ]

  expect(shipped.length).toBeGreaterThan(40)
  expect(shipped.filter(name => !credited.has(name))).toEqual([])
})

it('links every project to its GitHub repository', () => {
  for (const project of OPEN_SOURCE.flatMap(group => group.projects)) {
    expect(project.repository).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/)
  }
})
