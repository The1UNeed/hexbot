/** One open source project Hexbot ships or is built on, shown in Settings, About, Licenses. */
export interface OpenSourceProject {
  license: string
  name: string
  /** Direct dependency names this entry covers; `licenses.test.ts` checks none is missing. */
  packages?: string[]
  repository: string
  /** Bundled skills carrying this project's license; `licenses.test.ts` checks none is missing. */
  skills?: string[]
}

export interface OpenSourceGroup {
  projects: OpenSourceProject[]
  title: string
}

export const OPEN_SOURCE: OpenSourceGroup[] = [
  {
    title: 'Built on',
    projects: [
      {
        license: 'MIT',
        name: 'Hermes Agent',
        repository: 'https://github.com/NousResearch/hermes-agent'
      },
      {
        license: 'MIT',
        name: 'Pi',
        packages: ['@earendil-works/pi-coding-agent'],
        repository: 'https://github.com/earendil-works/pi'
      },
      { license: 'MIT', name: 'Node.js', repository: 'https://github.com/nodejs/node' },
      {
        license: 'MIT OR Unlicense',
        name: 'ripgrep',
        repository: 'https://github.com/BurntSushi/ripgrep'
      },
      { license: 'MIT OR Apache-2.0', name: 'fd', repository: 'https://github.com/sharkdp/fd' },
      { license: 'Public domain', name: 'SQLite', repository: 'https://github.com/sqlite/sqlite' },
      { license: 'MIT OR Apache-2.0', name: 'uv', repository: 'https://github.com/astral-sh/uv' },
      { license: 'PSF-2.0', name: 'Python', repository: 'https://github.com/python/cpython' },
      { license: 'LGPL-3.0', name: 'edge-tts', repository: 'https://github.com/rany2/edge-tts' },
      {
        license: 'Apache-2.0',
        name: 'cloudflared',
        repository: 'https://github.com/cloudflare/cloudflared'
      }
    ]
  },
  {
    title: 'Skills',
    projects: [
      {
        license: 'MIT',
        name: 'Humanizer',
        repository: 'https://github.com/blader/humanizer',
        skills: ['humanizer']
      }
    ]
  },
  {
    title: 'App',
    projects: [
      {
        license: 'MIT',
        name: 'Electron',
        packages: ['electron'],
        repository: 'https://github.com/electron/electron'
      },
      {
        license: 'MIT',
        name: 'electron-updater',
        packages: ['electron-updater'],
        repository: 'https://github.com/electron-userland/electron-builder'
      },
      {
        license: 'MIT',
        name: 'React',
        packages: ['react', 'react-dom'],
        repository: 'https://github.com/facebook/react'
      },
      {
        license: 'MIT',
        name: 'Base UI',
        packages: ['@base-ui/react'],
        repository: 'https://github.com/mui/base-ui'
      },
      {
        license: 'MIT',
        name: 'TanStack Router',
        packages: ['@tanstack/react-router'],
        repository: 'https://github.com/TanStack/router'
      },
      {
        license: 'MIT',
        name: 'Tailwind CSS',
        packages: ['tailwindcss'],
        repository: 'https://github.com/tailwindlabs/tailwindcss'
      },
      {
        license: 'MIT',
        name: 'tailwind-merge',
        packages: ['tailwind-merge'],
        repository: 'https://github.com/dcastil/tailwind-merge'
      },
      {
        license: 'Apache-2.0',
        name: 'class-variance-authority',
        packages: ['class-variance-authority'],
        repository: 'https://github.com/joe-bell/cva'
      },
      {
        license: 'MIT',
        name: 'clsx',
        packages: ['clsx'],
        repository: 'https://github.com/lukeed/clsx'
      },
      {
        license: 'MIT',
        name: 'Zustand',
        packages: ['zustand'],
        repository: 'https://github.com/pmndrs/zustand'
      },
      {
        license: 'MIT',
        name: 'react-markdown',
        packages: ['react-markdown'],
        repository: 'https://github.com/remarkjs/react-markdown'
      },
      {
        license: 'MIT',
        name: 'remark-gfm',
        packages: ['remark-gfm'],
        repository: 'https://github.com/remarkjs/remark-gfm'
      },
      {
        license: 'ISC',
        name: 'Lucide',
        packages: ['lucide-react'],
        repository: 'https://github.com/lucide-icons/lucide'
      },
      {
        license: 'MIT',
        name: 'node-qrcode',
        packages: ['qrcode'],
        repository: 'https://github.com/soldair/node-qrcode'
      },
      {
        license: 'CC0-1.0',
        name: 'Simple Icons',
        repository: 'https://github.com/simple-icons/simple-icons'
      }
    ]
  },
  {
    title: 'Daemon',
    projects: [
      {
        license: 'MIT',
        name: 'Tokio',
        packages: ['tokio'],
        repository: 'https://github.com/tokio-rs/tokio'
      },
      {
        license: 'MIT',
        name: 'axum',
        packages: ['axum'],
        repository: 'https://github.com/tokio-rs/axum'
      },
      {
        license: 'MIT',
        name: 'tower-http',
        packages: ['tower-http'],
        repository: 'https://github.com/tower-rs/tower-http'
      },
      {
        license: 'MIT',
        name: 'tokio-tungstenite',
        packages: ['tokio-tungstenite'],
        repository: 'https://github.com/snapview/tokio-tungstenite'
      },
      {
        license: 'MIT OR Apache-2.0',
        name: 'futures-rs',
        packages: ['futures-util'],
        repository: 'https://github.com/rust-lang/futures-rs'
      },
      {
        license: 'MIT OR Apache-2.0',
        name: 'reqwest',
        packages: ['reqwest'],
        repository: 'https://github.com/seanmonstar/reqwest'
      },
      {
        license: 'MIT',
        name: 'rusqlite',
        packages: ['rusqlite'],
        repository: 'https://github.com/rusqlite/rusqlite'
      },
      {
        license: 'MIT OR Apache-2.0',
        name: 'Serde',
        packages: ['serde'],
        repository: 'https://github.com/serde-rs/serde'
      },
      {
        license: 'MIT OR Apache-2.0',
        name: 'serde_json',
        packages: ['serde_json'],
        repository: 'https://github.com/serde-rs/json'
      },
      {
        license: 'MIT OR Apache-2.0',
        name: 'serde_yaml',
        packages: ['serde_yaml'],
        repository: 'https://github.com/dtolnay/serde-yaml'
      },
      {
        license: 'Apache-2.0',
        name: 'yaml-edit',
        packages: ['yaml-edit'],
        repository: 'https://github.com/jelmer/yaml-edit'
      },
      {
        license: 'MIT',
        name: 'jsonschema',
        packages: ['jsonschema'],
        repository: 'https://github.com/Stranger6667/jsonschema'
      },
      {
        license: 'MIT',
        name: 'jsonwebtoken',
        packages: ['jsonwebtoken'],
        repository: 'https://github.com/Keats/jsonwebtoken'
      },
      {
        license: 'Apache-2.0 AND ISC',
        name: 'ring',
        packages: ['ring'],
        repository: 'https://github.com/briansmith/ring'
      },
      {
        license: 'MIT OR Apache-2.0',
        name: 'RustCrypto hashes',
        packages: ['sha2'],
        repository: 'https://github.com/RustCrypto/hashes'
      },
      {
        license: 'MIT OR Apache-2.0',
        name: 'rust-base64',
        packages: ['base64'],
        repository: 'https://github.com/marshallpierce/rust-base64'
      },
      {
        license: 'MIT OR Apache-2.0',
        name: 'rand',
        packages: ['rand'],
        repository: 'https://github.com/rust-random/rand'
      },
      {
        license: 'MIT OR Apache-2.0',
        name: 'uuid',
        packages: ['uuid'],
        repository: 'https://github.com/uuid-rs/uuid'
      },
      {
        license: 'MIT OR Apache-2.0',
        name: 'chrono',
        packages: ['chrono'],
        repository: 'https://github.com/chronotope/chrono'
      },
      {
        license: 'MIT OR Apache-2.0',
        name: 'regex',
        packages: ['regex'],
        repository: 'https://github.com/rust-lang/regex'
      },
      {
        license: 'MIT OR Apache-2.0',
        name: 'semver',
        packages: ['semver'],
        repository: 'https://github.com/dtolnay/semver'
      },
      {
        license: 'MIT OR Apache-2.0',
        name: 'rust-url',
        packages: ['url'],
        repository: 'https://github.com/servo/rust-url'
      },
      {
        license: 'MIT OR Apache-2.0',
        name: 'unicode-normalization',
        packages: ['unicode-normalization'],
        repository: 'https://github.com/unicode-rs/unicode-normalization'
      },
      {
        license: 'MIT OR Apache-2.0',
        name: 'image',
        packages: ['image'],
        repository: 'https://github.com/image-rs/image'
      },
      {
        license: 'MIT OR Apache-2.0',
        name: 'qrcode-rust',
        packages: ['qrcode'],
        repository: 'https://github.com/kennytm/qrcode-rust'
      },
      {
        license: 'MIT OR Apache-2.0',
        name: 'tar-rs',
        packages: ['tar'],
        repository: 'https://github.com/composefs/tar-rs'
      },
      {
        license: 'MIT OR Apache-2.0',
        name: 'flate2',
        packages: ['flate2'],
        repository: 'https://github.com/rust-lang/flate2-rs'
      },
      {
        license: 'MIT OR Apache-2.0',
        name: 'tempfile',
        packages: ['tempfile'],
        repository: 'https://github.com/Stebalien/tempfile'
      },
      {
        license: 'MIT OR Apache-2.0',
        name: 'thiserror',
        packages: ['thiserror'],
        repository: 'https://github.com/dtolnay/thiserror'
      },
      {
        license: 'MIT',
        name: 'dotenvy',
        packages: ['dotenvy'],
        repository: 'https://github.com/allan2/dotenvy'
      },
      {
        license: 'MIT OR BSD-3-Clause',
        name: 'if-addrs',
        packages: ['if-addrs'],
        repository: 'https://github.com/messense/if-addrs'
      },
      {
        license: 'MIT OR Apache-2.0',
        name: 'libc',
        packages: ['libc'],
        repository: 'https://github.com/rust-lang/libc'
      }
    ]
  }
]
