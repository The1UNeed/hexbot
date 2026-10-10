#!/usr/bin/env node
// A fake update server and an isolated home for trying the Hexbot Installer
// by hand: `pnpm --filter ./apps/installer run dev:fake`.
//
// It builds a synthetic install/nightly.json with a fake Client and Full app
// and a fake native archive whose `hexbot` script stands in for the daemon
// (setup, service, status, pair), serves it from 127.0.0.1, and starts
// `tauri dev` with HOME, HEXBOT_HOME, the apps directory, and the service
// root all in a temp directory. Nothing touches ~/.hexbot, /Applications,
// or ~/Library/LaunchAgents. No stable.json is published, so the installer
// defaults to Nightly and shows how a missing Stable release looks.
//
//   --root DIR      reuse DIR (run again to see the installed screens)
//   --server-only   serve the tree and print the environment; no window
//   --rate MBPS     download speed, so the progress bar is visible (default 4)

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { prepareRoot } from './dev-fake-root.mjs'
import { signUpdates, testKey, testPublicKey } from '../../../scripts/desktop/update-signing.mjs'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(appDir, '../..')

function option(name) {
  const index = process.argv.indexOf(name)

  return index === -1 ? undefined : process.argv[index + 1]
}

const serverOnly = process.argv.includes('--server-only')
const rate = Number(option('--rate') ?? 4) * 1_000_000
const realHome = os.homedir()

let root

try {
  root = prepareRoot(
    option('--root') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'hexbot-installer-fake-')),
    realHome
  )
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

const dirs = {
  apps: path.join(root, 'apps'),
  build: path.join(root, 'build'),
  home: path.join(root, 'home'),
  server: path.join(root, 'server'),
  services: path.join(root, 'services')
}

dirs.hexbotHome = path.join(dirs.home, '.hexbot')
fs.rmSync(dirs.server, { force: true, recursive: true })
fs.rmSync(dirs.build, { force: true, recursive: true })
for (const dir of Object.values(dirs)) {
  fs.mkdirSync(dir, { recursive: true })
}

const target = {
  'darwin-arm64': 'macos-aarch64',
  'darwin-x64': 'macos-x86_64',
  'linux-x64': 'linux-x86_64'
}[`${process.platform}-${process.arch}`]

if (!target) {
  console.error(`Hexbot has no build for ${process.platform}/${process.arch}.`)
  process.exit(1)
}

const macos = process.platform === 'darwin'
const desktop = JSON.parse(fs.readFileSync(path.join(repo, 'apps/desktop/package.json'), 'utf8'))
const day = new Date().toISOString().slice(0, 10).replaceAll('-', '')
const version = `${desktop.version.split('-')[0]}-nightly.${day}.1`

function executable(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  fs.chmodSync(file, 0o755)
}

/** Incompressible filler, so downloads take long enough to watch. */
function padding(file, megabytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, randomBytes(megabytes * 1_000_000))
}

function digests(file) {
  const bytes = fs.readFileSync(file)

  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sha512: createHash('sha512').update(bytes).digest('base64'),
    size: bytes.length
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed`)
  }
}

function fakeApp(name, appId, megabytes) {
  if (macos) {
    const bundle = path.join(dirs.build, `${name}.app`)
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${appId}</string>
<key>CFBundleName</key><string>${name}</string>
<key>CFBundleExecutable</key><string>fake-hexbot</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version.split('-')[0]}</string>
</dict></plist>
`

    fs.mkdirSync(path.join(bundle, 'Contents/MacOS'), { recursive: true })
    fs.writeFileSync(path.join(bundle, 'Contents/Info.plist'), plist)
    executable(
      path.join(bundle, 'Contents/MacOS/fake-hexbot'),
      `#!/bin/sh\n/usr/bin/osascript -e 'display notification "The fake ${name} opened." with title "Hexbot Installer dev:fake"'\n`
    )
    padding(path.join(bundle, 'Contents/Resources/padding.bin'), megabytes)

    const archive = path.join(dirs.server, `${appId}.zip`)

    run('/usr/bin/ditto', ['-c', '-k', '--keepParent', bundle, archive])

    return { archive, format: 'zip' }
  }

  const archive = path.join(dirs.server, `${appId}.AppImage`)

  executable(archive, `#!/bin/sh\necho "The fake ${name} opened."\nexit 0\n`)
  fs.appendFileSync(archive, randomBytes(megabytes * 1_000_000))

  return { archive, format: 'AppImage' }
}

// Emulates the daemon CLI the way backend/hexbot-installer/tests/common/mod.rs
// does, with pauses so each setup stage shows in the window.
const fakeHexbot = `#!/bin/sh
set -eu
[ "\${HEXBOT_SERVICE_NO_LOAD:-}" = 1 ] || { echo "The fake hexbot only runs with HEXBOT_SERVICE_NO_LOAD=1." >&2; exit 1; }
case "$(uname -s)" in
  Darwin) service="$HEXBOT_SERVICE_ROOT/Library/LaunchAgents/app.hexbot.daemon.plist" ;;
  *) service="$HEXBOT_SERVICE_ROOT/.config/systemd/user/hexbot.service" ;;
esac
emit() { printf '{"stage":"%s","message":"%s"}\\n' "$1" "$2"; sleep "\${3:-0.6}"; }
case "\${1:-}" in
  --version) echo "${version}" ;;
  setup)
    [ "$*" = 'setup --activate --json' ]
    emit verify "Verifying the native runtime"
    emit copy "Copying the native runtime"
    mkdir -p "$HEXBOT_HOME/runtime/native/${version}" "$HOME/.local/bin"
    cp "$0" "$HEXBOT_HOME/runtime/native/${version}/hexbot"
    cp "$0" "$HEXBOT_HOME/runtime/native-executable"
    chmod +x "$HEXBOT_HOME/runtime/native-executable"
    emit activate "Activating the native runtime"
    printf '{"version":"${version}"}\\n' > "$HEXBOT_HOME/runtime/native-current.json"
    emit uv "Preparing the code runtime installer"
    emit python "Installing Python for code tools" 2
    emit voice "Installing voice tools" 1.5
    printf "#!/bin/sh\\n# Hexbot CLI, written by hexbot setup\\nexport HEXBOT_HOME='%s'\\nexec '%s' \\"\\$@\\"\\n" "$HEXBOT_HOME" "$HEXBOT_HOME/runtime/native-executable" > "$HOME/.local/bin/hexbot"
    chmod +x "$HOME/.local/bin/hexbot"
    emit link "CLI installed at $HOME/.local/bin/hexbot" 0.2
    case ":$PATH:" in
      *":$HOME/.local/bin:"*) ;;
      *) emit link 'Add to your shell profile: export PATH=\\"$HOME/.local/bin:$PATH\\"' 0 ;;
    esac
    emit done "Hexbot setup complete" 0
    ;;
  service)
    case "\${2:-}" in
      install)
        mkdir -p "$(dirname "$service")"
        # The same shape as the real files, so the engine's ownership checks pass.
        case "$(uname -s)" in
          Darwin) printf '<key>HEXBOT_HOME</key><string>%s</string><key>ProgramArguments</key><array><string>%s/runtime/native-executable</string></array>\\n' "$HEXBOT_HOME" "$HEXBOT_HOME" > "$service" ;;
          *) printf 'Environment=HEXBOT_HOME="%s"\\nExecStart="%s/runtime/native-executable" serve\\n' "$HEXBOT_HOME" "$HEXBOT_HOME" > "$service" ;;
        esac
        sleep 0.5; echo "Daemon service installed" ;;
      stop) echo "Daemon service stopped" ;;
      uninstall) rm -f "$service"; echo "Daemon service removed" ;;
      logs) echo "The fake daemon writes no logs." ;;
      *) exit 1 ;;
    esac ;;
  lan)
    case "\${2:-}" in on) touch "$HEXBOT_HOME/lan-on" ;; off) rm -f "$HEXBOT_HOME/lan-on" ;; *) exit 1 ;; esac
    echo "LAN access is \${2}." ;;
  status)
    running=false; [ -f "$service" ] && running=true
    printf '{"running":%s,"version":"${version}","port":9119,"lan_addresses":["192.168.1.24"],"lan_enabled":true,"tailscale_ipv4":"100.101.102.103","connect_hostname":null,"service":{"installed":%s,"running":%s},"sandbox_available":true}\\n' "$running" "$running" "$running" ;;
  pair)
    code=$(LC_ALL=C tr -dc 'A-HJ-NP-Z2-9' < /dev/urandom | head -c 8)
    code="$(printf %s "$code" | cut -c1-4)-$(printf %s "$code" | cut -c5-8)"
    printf 'Pairing code: %s\\nExpires in: 10 minutes\\nAddresses: 192.168.1.24:9119\\nLink: hexbot://pair?host=192.168.1.24&port=9119#code=%s\\n' "$code" "$code" ;;
  *) echo "The fake hexbot does not know: $*" >&2; exit 1 ;;
esac
`

function fakeNative() {
  const dir = path.join(dirs.build, 'native')

  executable(path.join(dir, 'hexbot'), fakeHexbot)
  padding(path.join(dir, 'hexbot-core'), 8)
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ files: [], version }, null, 2))

  const archive = path.join(dirs.server, 'native.tar.gz')

  // COPYFILE_DISABLE keeps macOS tar from adding AppleDouble entries.
  run('tar', ['-C', dir, '-czf', archive, 'hexbot', 'hexbot-core', 'manifest.json'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' }
  })

  return archive
}

console.log('Building the fake release...')

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const file = path.join(dirs.server, path.normalize(decodeURIComponent(url.pathname)))

  if (!file.startsWith(dirs.server) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404).end()

    return
  }

  const bytes = fs.readFileSync(file)

  response.writeHead(200, { 'Cache-Control': 'no-cache', 'Content-Length': bytes.length })

  // Throttled, so the download bar moves at a watchable pace.
  const chunk = 64 * 1024
  const pause = Math.max(1, Math.round((chunk / rate) * 1000))
  let offset = 0

  const send = () => {
    if (offset >= bytes.length || response.destroyed) {
      response.end()

      return
    }

    response.write(bytes.subarray(offset, offset + chunk))
    offset += chunk
    setTimeout(send, pause)
  }

  send()
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

const base = `http://127.0.0.1:${server.address().port}`
const full = fakeApp('Hexbot Nightly', 'app.hexbot.desktop.nightly', 18)
const client = fakeApp('Hexbot Client Nightly', 'app.hexbot.client.nightly', 12)
const native = fakeNative()

function artifact(file, extra) {
  const { sha256, sha512, size } = digests(file)
  const url = `${base}/${path.basename(file)}`

  return extra.format === 'tar.gz'
    ? { format: 'tar.gz', sha256, size, url }
    : { sha512, size, url, ...extra }
}

fs.mkdirSync(path.join(dirs.server, 'install'), { recursive: true })
fs.writeFileSync(
  path.join(dirs.server, 'install/nightly.json'),
  JSON.stringify(
    {
      channel: 'nightly',
      minInstaller: '0.0.1',
      schema: 1,
      targets: {
        [target]: {
          client: artifact(client.archive, {
            appId: 'app.hexbot.client.nightly',
            format: client.format,
            productName: 'Hexbot Client Nightly'
          }),
          full: artifact(full.archive, {
            appId: 'app.hexbot.desktop.nightly',
            format: full.format,
            productName: 'Hexbot Nightly'
          }),
          headless: artifact(native, { format: 'tar.gz' })
        }
      },
      version
    },
    null,
    2
  )
)
// Debug builds of the installer trust the public test key, as release builds trust the release key.
signUpdates(dirs.server, { channel: 'nightly', version, key: testKey(), expected: testPublicKey() })

const environment = {
  HEXBOT_HOME: dirs.hexbotHome,
  HEXBOT_INSTALL_APPS_DIR: dirs.apps,
  HEXBOT_SERVICE_NO_LOAD: '1',
  HEXBOT_SERVICE_ROOT: dirs.services,
  HEXBOT_UPDATE_URL: base,
  HOME: dirs.home
}

console.log(`\nFake update server: ${base}/install/nightly.json (${version})`)
for (const [key, value] of Object.entries(environment)) {
  console.log(`  ${key}=${value}`)
}

console.log(`\nRun again with --root ${root} to see the installed screens.`)

if (serverOnly) {
  console.log('Serving until Ctrl-C.')
} else {
  // The fake HOME must not hide the real Rust toolchain from `tauri dev`.
  const toolchain = {
    CARGO_HOME: process.env.CARGO_HOME ?? path.join(realHome, '.cargo'),
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? path.join(realHome, '.rustup')
  }
  const env = { ...process.env, ...toolchain, ...environment }

  delete env.HEXBOT_TRACK

  const tauri = spawn(path.join(appDir, 'node_modules/.bin/tauri'), ['dev'], {
    cwd: appDir,
    detached: true,
    env,
    stdio: 'inherit'
  })

  const stop = () => {
    try {
      process.kill(-tauri.pid, 'SIGTERM')
    } catch {
      // Already gone.
    }
  }

  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  tauri.on('exit', code => {
    server.close()
    process.exit(code ?? 0)
  })
}
