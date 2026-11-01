---
layout: ../../layouts/Docs.astro
title: Diagnostics
description: See how your Hexbot daemon launched, what it uses, how its runs went, and how well the prompt cache works.
---

Diagnostics shows what the daemon has measured since it started. Use it when Hexbot feels slow, a bot keeps failing, or you want to know what a run cost in time. Open Settings, Advanced, **Diagnostics** in the desktop app or a browser. The page refreshes every 5 seconds while it is open. The mobile app has no Diagnostics.

![Settings, Diagnostics: launch time, uptime, CPU, memory and cache hit tiles above the launch waterfall.](/screens/diagnostics.webp)

## Overview

Six tiles sum up the daemon:

| Tile | What it shows |
| --- | --- |
| Launch time | From the daemon starting until it was ready for apps. |
| Uptime | How long the daemon has run, and since when. |
| CPU | The daemon's processor use, and how many processes it runs. |
| Memory | Memory in use, out of the computer's total. |
| Prompt cache hits | How much of what bots sent their models was read from the provider's prompt cache over the last 24 hours. |
| Database cache hits | How often the local database found what it needed in memory. |

Under them, **Launch** lays each startup step on one time axis, such as upgrading the database or starting bots, rooms, and memory, so a slow step stands out. The page also shows system load, the host and daemon, and this window's own load time and round trip to the daemon.

## Resources

CPU and memory over the last hour, one chart each, with a crosshair that reads out any moment. The process tree lists every process the daemon runs, such as agent runtimes and MCP servers; select one to chart its last ten minutes.

## Traces

**Recent runs** lists each time a bot answered. Open a run to see a waterfall of its model calls and tool steps with their timings and details, including how long the first token took. **Span names** groups every kind of step with its count, failures, average, p95, and slowest time, and the span log lists them one by one, filtered by name.

## Failures and caches

**Failures** shows the most common failures and the latest ones since the daemon started. **Caches** breaks prompt cache use down by bot and by model, and shows the local database's cache, file sizes, and slowest statements.

A low prompt cache hit rate usually means conversations are being rebuilt, for example after tools or connectors change. [Bots and chats](/docs/bots-and-sections/#keep-the-chat-going) explains when that happens.

## Share a report

**Copy report** copies everything on the page as JSON for a bug report. Where the browser can't use the clipboard, such as a plain `http://` address, it saves `hexbot-diagnostics.json` instead. The report holds names, timings, token counts, and error messages, never the text of your messages. Error messages can still name files or accounts, so read it before posting it publicly.

Without the app, run `hexbot diagnostics` on the daemon computer for the same report. See [CLI](/docs/cli/).
