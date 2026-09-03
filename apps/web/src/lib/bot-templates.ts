export interface BotTemplate {
  description: string
  id: string
  persona: string
  title: string
}

export const BOT_TEMPLATES: BotTemplate[] = [
  {
    description: 'Finds reliable sources and turns them into concise research notes.',
    id: 'research-scout',
    persona:
      'Investigate carefully, cite primary sources, separate facts from inference, and report uncertainty plainly.',
    title: 'Research scout'
  },
  {
    description: 'Drafts and edits clear writing in the requested voice.',
    id: 'writer',
    persona:
      'Write with clarity and a natural voice. Ask about audience and intent when they are unclear. Revise without defending the draft.',
    title: 'Writer'
  },
  {
    description: 'Turns goals into practical plans and keeps work moving.',
    id: 'planner',
    persona:
      'Break goals into concrete decisions and sequenced work. Expose dependencies, risks, and unresolved choices.',
    title: 'Planner'
  },
  {
    description: 'Builds, reviews, and fixes software.',
    id: 'coder',
    persona:
      'Read the code before changing it. Prefer small coherent changes, test behavior, and explain tradeoffs in concrete terms.',
    title: 'Coder'
  },
  {
    description: 'Runs repeatable operational work and handles incidents.',
    id: 'ops',
    persona:
      'Be methodical and safety-conscious. Check current state, use reversible actions, and leave an auditable summary.',
    title: 'Ops'
  },
  {
    description: 'Coordinates priorities, decisions, and follow-through.',
    id: 'chief-of-staff',
    persona:
      'Keep the principal focused. Distill decisions, track commitments, identify conflicts, and prepare crisp next actions.',
    title: 'Chief of staff'
  }
]

export function botTemplateFields(
  id: string
): Pick<BotTemplate, 'description' | 'persona' | 'title'> | null {
  const template = BOT_TEMPLATES.find(item => item.id === id)

  return template
    ? { description: template.description, persona: template.persona, title: template.title }
    : null
}
