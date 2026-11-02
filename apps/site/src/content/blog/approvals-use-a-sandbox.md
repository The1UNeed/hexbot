---
title: Approvals now use a sandbox, with three modes
description: Manual, Auto, and Bypass replace the old approver model. In Auto, the default, commands run in a sandbox with no network, and a bot asks only when it needs to step outside.
date: 2026-10-04
---

Until today, a small model looked at each step a bot wanted to take and guessed whether it was safe. Behind it sat a long list of risky shell patterns. It asked too often, sometimes for the wrong things, and it was hard to say exactly what it protected.

Today's nightly replaces it with the operating system's sandbox and three modes. You choose one per bot.

## Auto

Auto is the new default. A bot's commands run in a sandbox that can write only inside its workspace and has no network. Most work happens there without a prompt. When a bot needs more, such as installing a package or writing outside its folder, it asks, and says why. File changes outside the workspace ask too.

## Manual

The sandbox is read-only. Every file change and every code run asks first.

## Bypass

No prompts and no sandbox. The bot can do anything you can do on the daemon's computer, including reading your provider keys. Use it only for a bot you trust with all of that.

## Answering

An approval card offers **Approve**, **Allow** for the rest of the conversation, and **Deny**. The old "Always allow" patterns are gone, along with the approver model and its setting.

If you picked a mode before, your bots keep it. Bots that never had one move to Auto. On Linux, bubblewrap can protect only files that already exist, so a workspace that contains your home folder could create a missing `.bashrc`. [Approvals](/docs/approvals/) has the details.
