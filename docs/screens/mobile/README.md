# Hexbot mobile screenshots

The app is laid out like a messaging app: one list of chats, rooms and
Check-ins, Settings behind your initials, + for a new bot or room, and Bots &
jobs behind the grid button next to Search.

Browser captures from the mobile smoke test on 2026-10-26, at iPhone size,
paired with a disposable Rust daemon and the pinned Pi runtime. A local
streaming model fixture supplied replies.

| Chats | New | Chat |
| --- | --- | --- |
| ![Chat list with bots and rooms](web-home.png) | ![New bot or room menu](web-home-new.png) | ![A bot's chat](web-chat.png) |

| Room | Settings | Bots & jobs |
| --- | --- | --- |
| ![A room, full screen](web-room.png) | ![Settings](web-settings.png) | ![Bots and jobs](web-library.png) |

Native captures from 2026-10-08, from the Expo development app. iOS used an
iPhone 17 Pro simulator on iOS 26.5; Android an arm64 emulator on Android 16,
API 36. They predate the chat list; the screens below are unchanged by it.

| Connect | Daemon switcher | Profile in dark appearance |
| --- | --- | --- |
| ![iOS connection](ios-connect.png) | ![iOS daemon switcher](ios-daemon-switcher.png) | ![iOS profile card](ios-profile-dark.png) |

| Model menu | Android chat | Android revoked device |
| --- | --- | --- |
| ![Web preview supported reasoning choices](web-model-menu.png) | ![Android native message](android-chat.png) | ![Android returns to pairing after revocation](android-revoked-device-dark.png) |

Retake the chat list, a chat and a room on an iOS simulator and an Android
emulator; these have only browser captures so far.

See [the mobile README](../../../apps/mobile/README.md) and
[testing instructions](../../testing.md) to reproduce the checks. CI uploads
the web integration screenshots and report as the `mobile-evidence` artifact.
Physical devices and production Hex Connect sign-in remain manual checks.
