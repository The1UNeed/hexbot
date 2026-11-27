import { skillContent, skillFileName } from './skill-file'

describe('skill files', () => {
  it('writes a description any YAML reader takes, then the instructions', () => {
    expect(skillContent(' Notes: "quoted" ', '\nStep one.\n')).toBe(
      '---\ndescription: "Notes: \\"quoted\\""\n---\n\nStep one.\n'
    )
  })

  it("reads a loaded file's own name only when Hexbot accepts it", () => {
    expect(skillFileName('---\nname: release-notes\ndescription: x\n---\nBody')).toBe(
      'release-notes'
    )
    expect(skillFileName('﻿---\r\nname: "notes"\r\n---\r\nBody')).toBe('notes')
    expect(skillFileName('---\nname: Release Notes\n---\nBody')).toBe('')
    expect(skillFileName('name: outside\n')).toBe('')
  })
})
