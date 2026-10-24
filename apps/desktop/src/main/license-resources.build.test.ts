import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

// Resolve both packages' configurations and copy their resources with
// electron-builder's own loader and copier, from the version that builds them.
interface FileMatcher {
  from: string
  to: string
}
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const repositoryRoot = resolve(desktopRoot, '../..')
const builder = createRequire(createRequire(join(desktopRoot, 'package.json')).resolve('electron-builder'))
const { getConfig, validateConfiguration } = builder('app-builder-lib/out/util/config/config')
const { copyFiles, getFileMatchers } = builder('app-builder-lib/out/fileMatcher') as {
  copyFiles: (matchers: FileMatcher[]) => Promise<void>
  getFileMatchers: (config: unknown, name: string, destination: string, options: object) => FileMatcher[] | null
}
const { DebugLogger } = builder('builder-util')
const outputs: string[] = []

afterAll(() => Promise.all(outputs.map(dir => rm(dir, { force: true, recursive: true }))))

async function resources(configFile: string | null, platform: 'mac' | 'linux') {
  const config = await getConfig(desktopRoot, configFile && join(desktopRoot, configFile), null)
  await validateConfiguration(config, new DebugLogger(false))
  const destination = await mkdtemp(join(tmpdir(), 'hexbot-resources-'))
  outputs.push(destination)
  const matchers = getFileMatchers(config, 'extraResources', destination, {
    customBuildOptions: config[platform] ?? {},
    defaultSrc: desktopRoot,
    globalOutDir: join(desktopRoot, 'release'),
    macroExpander: (pattern: string) => pattern
  }) ?? []
  // Copy only the license files; the daemon runtime may not be staged here.
  await copyFiles(matchers.filter(matcher => dirname(matcher.from) === repositoryRoot))
  return {
    destination,
    mapping: matchers.map(matcher => [relative(repositoryRoot, matcher.from), relative(destination, matcher.to)])
  }
}

const notices = [
  ['LICENSE', 'LICENSE'],
  ['NOTICE', 'NOTICE']
]

describe('license resources', () => {
  for (const platform of ['mac', 'linux'] as const) {
    for (const [edition, configFile, mapping] of [
      ['full', null, [...notices, ['apps/desktop/resources/hexbot-native', 'hexbot-native']]],
      ['client', 'electron-builder.client.yml', notices]
    ] as const) {
      it(`${edition} on ${platform} ships the repository's LICENSE and NOTICE`, async () => {
        const result = await resources(configFile, platform)
        expect(result.mapping).toEqual(mapping)
        for (const file of ['LICENSE', 'NOTICE'])
          expect(await readFile(join(result.destination, file))).toEqual(await readFile(join(repositoryRoot, file)))
      })
    }
  }
})
