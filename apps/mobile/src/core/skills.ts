import type { SkillRequirement } from './types'

const PLATFORMS: Record<string, string> = { linux: 'Linux', macos: 'macOS', windows: 'Windows' }

/** What a skill still needs, in a few words, as on the web: "Needs memo installed". */
export function requirementText(missing: SkillRequirement[]): string {
  return missing
    .map(item =>
      item.kind === 'platform'
        ? `Only on ${item.name.map(name => PLATFORMS[name] ?? name).join(' or ')}`
        : item.kind === 'command'
          ? `Needs ${item.name} installed`
          : `Needs ${item.name}`
    )
    .join(' · ')
}
