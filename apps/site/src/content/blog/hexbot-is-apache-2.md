---
title: Hexbot is now under Apache-2.0
description: Every part of Hexbot, Hex Connect included, now uses the Apache License 2.0 instead of the AGPL.
date: 2026-10-24
---

Hexbot has been open source from the start, under the GNU Affero General Public License. As of today, Hexbot's own code is under the **Apache License 2.0**. That covers every part of Hexbot, Hex Connect included.

## What changes for you

If you use Hexbot, nothing. It's still free, and you can still read every line of it.

If you build on Hexbot, more is allowed. Apache-2.0 is a permissive license: you can use the code in your own projects, open or closed, as long as you keep the copyright and license notices. It also grants you a patent license from everyone who contributes.

## What doesn't

Code we use from other projects keeps its own license, and so do the bundled skills, which are MIT. Those credits stay in Settings, About and in the `NOTICE` file. Releases from before today keep the license they shipped with. Every package now carries the `LICENSE` and `NOTICE` files, and the terminal installer prints them with `--license`.

The home page now explains what the source covers, how to build Hexbot from it, and how to run your own Hex Connect.

## Also in recent nightlies: bots keep working with the window closed

On Windows and Linux, closing the window used to quit Hexbot and stop your bots. Now it keeps them running, as macOS already did. Replies still arrive as notifications. To stop Hexbot, choose File, Quit.
