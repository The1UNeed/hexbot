export const docGroups = [
  {
    title: 'Get started',
    pages: [
      { title: 'Install', summary: 'Choose a package and install it on macOS or Linux.', href: '/docs/install/' },
      { title: 'Quick start', summary: 'Connect a provider, create your first bot, and send a message.', href: '/docs/quick-start/' },
      { title: 'Providers and billing', summary: 'Add credentials, choose models, and understand usage charges.', href: '/docs/providers/' },
      { title: 'Bots and sections', summary: 'Give bots a role and manage their persistent conversations.', href: '/docs/bots-and-sections/' },
    ],
  },
  {
    title: 'Work with bots',
    pages: [
      { title: 'Tools, connectors, and skills', summary: 'Enable local tools, connect services, and add MCP servers.', href: '/docs/tools-and-skills/' },
      { title: 'Approvals', summary: 'Use Auto, Manual, or Bypass to control what a bot can do.', href: '/docs/approvals/' },
      { title: 'Memory', summary: "Edit a bot's soul and memory, and your About you text.", href: '/docs/memory/' },
      { title: 'Rooms', summary: 'Work with several bots and people, or ask another bot for private help.', href: '/docs/rooms/' },
      { title: 'Scheduled work', summary: 'Ask a bot to run reminders, recurring jobs, or scripts.', href: '/docs/scheduling/' },
      { title: 'Dreaming', summary: 'Review recent conversations and restore earlier bot memory.', href: '/docs/dreaming/' },
    ],
  },
  {
    title: 'Connect devices and people',
    pages: [
      { title: 'Pairing and LAN', summary: 'Pair an app or browser and revoke a device later.', href: '/docs/pairing-and-lan/' },
      { title: 'Tailscale', summary: 'Reach a daemon over your private network while away.', href: '/docs/tailscale/' },
      { title: 'Hex Connect', summary: 'Sign in from an app or browser without opening a router port.', href: '/docs/connect/' },
      { title: 'Multi-user', summary: 'Invite people, share bots, and set usage budgets.', href: '/docs/multi-user/' },
    ],
  },
  {
    title: 'Run and maintain Hexbot',
    pages: [
      { title: 'Updates', summary: 'Choose Stable or Nightly and update an app or remote daemon.', href: '/docs/updates/' },
      { title: 'CLI', summary: 'Start a daemon, manage devices, and send messages from a terminal.', href: '/docs/cli/' },
      { title: 'Run from source', summary: 'Set up development or build a standalone native daemon.', href: '/docs/development/' },
    ],
  },
]
