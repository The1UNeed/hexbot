import tools from '../../../../../backend/hexbot-core/assets/code-tools.json?raw'
import cargo from '../../../../../backend/hexbot-core/Cargo.toml?raw'
import services from '../../../../../backend/hexbot-core/src/services.rs?raw'
import pi from '../../../../../backend/pi-runtime/package.json'
import desktop from '../../../../desktop/package.json'
import web from '../../../package.json'

import { OPEN_SOURCE } from './licenses'

const projects = OPEN_SOURCE.flatMap(group => group.projects)
const credited = new Set(projects.flatMap(project => project.packages ?? []))

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

it('credits every tool the app or daemon downloads', () => {
  const repositories = new Set(projects.map(project => project.repository))

  const downloaded = [
    ...`${tools}\n${services}`.matchAll(
      /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\/download/g
    )
  ].map(match => `https://github.com/${match[1]}`)

  expect(downloaded.length).toBeGreaterThan(3)
  expect(downloaded.filter(repository => !repositories.has(repository))).toEqual([])
})

it('credits every bundled skill under a third-party license', () => {
  const licenses = import.meta.glob<string>('../../../../../skills/**/LICENSE', {
    eager: true,
    import: 'default',
    query: '?raw'
  })

  // Skills licensed by Nous Research came with Hermes Agent, credited above.
  const thirdParty = Object.entries(licenses)
    .filter(([, text]) => !text.includes('Nous Research'))
    .map(([path]) => path.split('/').at(-2))

  const skills = new Set(projects.flatMap(project => project.skills ?? []))

  expect(Object.keys(licenses).length).toBeGreaterThan(0)
  expect(thirdParty.filter(name => !name || !skills.has(name))).toEqual([])
})

it('links every project to its GitHub repository', () => {
  for (const project of projects) {
    expect(project.repository).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/)
  }
})
