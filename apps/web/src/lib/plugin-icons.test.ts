import { DEFAULT_SERVER_ICON, DEFAULT_SKILL_ICON, serverIcon, skillIcon } from './plugin-icons'

describe('plugin icons', () => {
  it('gives a bundled skill its own icon, then its category icon', () => {
    expect(skillIcon({ category: 'productivity', name: 'notion', source: 'bundled' })).toBe(
      'notion'
    )
    expect(skillIcon({ category: 'productivity', name: 'new-one', source: 'bundled' })).toBe(
      'glyph:list-checks'
    )
  })

  it('gives skills you or a bot wrote the default icon', () => {
    expect(skillIcon({ category: 'productivity', name: 'notion', source: 'library' })).toBe(
      DEFAULT_SKILL_ICON
    )
    expect(skillIcon({ name: 'my-routine', source: 'bot' })).toBe(DEFAULT_SKILL_ICON)
  })

  it('finds a brand in a server name, then its command or URL', () => {
    expect(serverIcon('github')).toBe('github')
    expect(
      serverIcon('docs', {
        args: ['-y', '@notionhq/notion-mcp-server'],
        command: 'npx',
        env: [],
        headers: [],
        transport: 'stdio'
      })
    ).toBe('notion')
    expect(
      serverIcon('issues', {
        env: [],
        headers: [],
        transport: 'http',
        url: 'https://mcp.linear.app/mcp'
      })
    ).toBe('linear')
    expect(
      serverIcon('my-drive', {
        args: ['google-drive'],
        command: 'uvx',
        env: [],
        headers: [],
        transport: 'stdio'
      })
    ).toBe('googledrive')
  })

  it('ignores the program that runs a server and words inside words', () => {
    expect(
      serverIcon('tools', {
        args: ['run', '-i', 'mcp/github'],
        command: 'docker',
        env: [],
        headers: [],
        transport: 'stdio'
      })
    ).toBe('github')
    expect(
      serverIcon('local', {
        args: ['-m', 'server'],
        command: 'python',
        env: [],
        headers: [],
        transport: 'stdio'
      })
    ).toBe(DEFAULT_SERVER_ICON)
    expect(serverIcon('sandbox')).toBe(DEFAULT_SERVER_ICON)
  })
})
