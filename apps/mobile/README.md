# Hexbot mobile

The Hexbot app for iPhone (and, next, Android): your bots and rooms on your
phone, talking to your own daemon. Expo SDK 57, expo-router, React Native
0.86. iOS 26 draws real Liquid Glass; other systems get a translucent stand-in.

The phone is a client of a daemon elsewhere, like the client-only desktop
package. It pairs over LAN or Tailscale with a one-time code (`hexbot pair`,
or Settings, Network in the desktop app); Hex Connect sign-in is not in this
version.

## What it does

- **Home**: every bot and room, newest activity first, with faces, labels,
  status dots, and when each was last active. Search and New (bot, room) sit
  in the native glass header; your initials open Settings.
- **Chat**: a bot's section with Markdown, code blocks, tables, attachments,
  live status ("Research is writing"), the steps a turn took, approvals,
  questions, Stop, drafts per section, and a header menu for sections,
  rename, archive, delete. A bot row continues its latest section; the
  compose button starts a fresh one.
- **Rooms**: the same chat for a room with several bots, room settings, new
  room.
- **Bots**: new bot with a face picker, the bot sheet (face, name, label,
  description, model, notifications) and its pages: Soul, Model, Memory and
  dreaming, Tools, Connectors, Skills, Approvals, Sections, Advanced.
- **Settings**: About you, Approvals, Appearance, Providers and default
  model, Usage, Network and pairing (code and QR for another device), Paired
  devices, Users, Hex Connect status, About. "Connect to another daemon"
  revokes this phone and returns to pairing.

## Layout

| Path | What |
| --- | --- |
| `src/app/` | Routes (expo-router). `_layout.tsx` is the root stack, the connection bootstrap and the pairing guard |
| `src/lib/` | Daemon contract and helpers. `api.ts`, `types.ts`, and `events.ts` follow the web client; `rpc.ts` retains replay cursors across reconnects; `connection.ts` is the phone's pairing and reconnect supervisor |
| `src/stores/` | zustand stores, the web client's, with storage swapped for AsyncStorage and the Keychain |
| `src/components/` | Faces, glass, the grouped list kit, chat, bot and settings pieces |
| `src/theme/` | Tokens from `docs/ui-design.md` |
| `scripts/demo-daemon.mjs` | A disposable daemon with a local streaming model and seeded bots |
| `scripts/sim.mjs` | Open, pair, screenshot and deep-link the iOS Simulator |

The device token lives in the iOS Keychain (Android Keystore). The phone
does not bind its token to a key (DPoP is optional on the daemon and React
Native has no WebCrypto), so treat a paired phone like any other device and
revoke it from Settings, Paired devices when it is lost.

## Run it

Needs Xcode 26 and CocoaPods for iOS, plus the daemon built from this
checkout.

```sh
pnpm install --frozen-lockfile
cargo build --locked --manifest-path backend/hexbot-core/Cargo.toml --bin hexbot
npm ci --prefix backend/pi-runtime --ignore-scripts --no-audit --no-fund

# A daemon for the phone: local model, seeded bots, never ~/.hexbot.
node apps/mobile/scripts/demo-daemon.mjs --home /tmp/hexbot-mobile-demo-home

# The dev build (once, and after native dependency changes), then Metro.
cd apps/mobile
npx expo run:ios --no-bundler
npx expo start
```

Pair the simulator with the address and code the demo script prints, or let
the helper do it: `node apps/mobile/scripts/sim.mjs pair <simulator udid>`.
A real phone on the same network needs `--lan` on the demo script and the
LAN address it prints. Against your own daemon, run `hexbot pair` there and
enter its address and code.

## Check it

```sh
pnpm --filter ./apps/mobile run typecheck
pnpm --filter ./apps/mobile run test
```

The unit tests run the stores and the connection supervisor in Node with
fakes for the native modules (`test/mocks`). Most store tests are the web
client's own, so the two clients keep the same behaviour.

Reconnects reuse the RPC client and replay events missed while offline. Switching
daemons clears cached chats, rooms, providers, devices, connectors, and drafts.
Bot settings show only tools available on the daemon computer.
Room creation inherits the daemon's approval mode and turn limits. HTTPS and WSS
addresses preserve TLS and default to port 443, including pairing links.
CI typechecks and tests the mobile app and exports both iOS and Android bundles.
