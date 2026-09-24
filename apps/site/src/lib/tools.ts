// What a bot can do, as the Tools and Connectors pages in the app list it
// (hexbot/bots.py TOOL_TOOLSETS, hexbot/connectors.py CATALOG). The Tools
// page and the landing page both read this, so keep it in step with the app.
export type Tool = { name: string; does: string; note?: string }
export type ToolGroup = { id: string; title: string; summary: string; tools: Tool[] }

export const toolGroups: ToolGroup[] = [
  {
    id: 'computer',
    title: 'On your computer',
    summary: 'On by default, no account needed. Each bot works in its own folder on the machine running Hexbot.',
    tools: [
      { name: 'Terminal', does: 'Run shell commands and long-running processes.', note: 'Risky commands ask first in Manual mode' },
      { name: 'Files', does: 'Read, write, edit, and search files.' },
      { name: 'Code execution', does: 'Run short scripts for data work and quick checks.', note: 'Risky scripts ask first' },
      { name: 'Browser', does: 'Drive a local Chrome window: open pages, click, fill forms.' },
      { name: 'Computer use', does: 'See the screen, click, and type in other apps.', note: 'Needs the cua driver installed' },
      { name: 'Vision', does: 'Look at images and screenshots you attach.', note: 'Needs a model that can see' },
    ],
  },
  {
    id: 'together',
    title: 'Working together',
    summary: 'What makes a crew more than several chats side by side.',
    tools: [
      { name: 'Rooms', does: 'Share one chat with people and several bots. Mention a bot to bring it in.' },
      { name: 'Message other bots', does: 'Ask another bot for help without being asked to.' },
      { name: 'Delegate', does: 'Hand a subtask to a copy of itself and carry on.' },
      { name: 'Scheduling', does: 'Set reminders and recurring jobs that run while you are away.' },
      { name: 'Clarifying questions', does: 'Ask you a question with choices instead of guessing.' },
      { name: 'To-do lists', does: 'Plan a longer job in steps and tick them off.' },
    ],
  },
  {
    id: 'memory',
    title: 'Memory and self',
    summary: 'Always on. This is how a bot stays the same bot from one week to the next.',
    tools: [
      { name: 'Memory', does: 'Keep its own notes about you, your work, and how you like things done.' },
      { name: 'Soul', does: 'Rewrite its own persona when you ask it to change, and tell you it did.' },
      { name: 'About you', does: 'Read the one text you write about yourself, shared by all your bots.' },
      { name: 'Search past chats', does: 'Find what was said in earlier conversations.' },
      { name: 'Skills', does: 'Follow saved playbooks, and write new ones from work that went well.' },
      { name: 'Dreaming', does: 'Tidy its memory once a day from that day\'s conversations.' },
    ],
  },
  {
    id: 'connectors',
    title: 'Connectors',
    summary: 'Opt in, with your own account. Set one up once, then switch it on for the bots that need it.',
    tools: [
      { name: 'Web search', does: 'Search the web and read pages.', note: 'Exa, Tavily, Brave, Firecrawl, Parallel, Keenable, or your own SearXNG' },
      { name: 'Cloud browser', does: 'A hosted browser for sites that block a local one.', note: 'Browserbase or Browser Use' },
      { name: 'Image generation', does: 'Make and edit images.', note: 'FAL or Krea' },
      { name: 'Video generation', does: 'Generate short clips.', note: 'FAL' },
      { name: 'Voice', does: 'Speak replies aloud.', note: 'ElevenLabs, OpenAI, or Mistral' },
      { name: 'Notion', does: 'Read and write pages and databases.' },
      { name: 'Airtable', does: 'Read and update bases.' },
      { name: 'X search', does: 'Search posts and profiles.', note: 'Through xAI' },
      { name: 'Home Assistant', does: 'Read sensors and control devices in your home.' },
      { name: 'MCP servers', does: 'Connect any MCP server, local or remote.' },
    ],
  },
]
