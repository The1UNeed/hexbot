---
layout: ../../layouts/Docs.astro
title: Passwords
description: Save sign-ins for your bots. They type them into pages and never see them.
---

Every bot can sign in to websites for you on its computer with passwords you save in Hexbot. The bot never reads a password: it asks Hexbot to type one into a field on the bots' computer.

## Saving a password from a chat

When a bot needs to sign in somewhere and has no password for it, it shows a **Sign in** card in its chat with fields for your username and password. What you type goes from your app to the daemon, which saves it. It never appears in the conversation, in the bot's history, or in what is sent to the model provider. The card then shows **Submitted**. Choose **Cancel** to tell the bot no.

If a saved password stops working, the bot shows the card again for that site so you can enter the current one.

A password saved from a card goes to every bot. Change that in Settings, Passwords.

## Settings, Passwords

Open Settings, Passwords to see every saved sign-in. From there you can:

- add a password, with an optional one-time code key (the setup key or `otpauth://` link from a site's two-factor setup), so bots can enter the six-digit code too;
- show or copy a password;
- edit the site, name, username, password, or notes;
- choose which bots can use each password, or give it to every bot, including bots you add later;
- delete a password.

In the mobile app, open your initials, then Passwords.

Your primary bot can do the same from its own chat, without seeing passwords: it can tell you which bots have a password, give one to a bot, rename it, or delete it. Deleting always asks you first.

## Where passwords are kept

Passwords are kept on the daemon's computer in one [KeePass](https://keepass.info) (KDBX 4) file per person, `~/.hexbot/users/<you>/passwords/passwords.kdbx`. The format is open, so you can open the file with [KeePassXC](https://keepassxc.org) or any KeePass app. The file is encrypted with a random key kept in the macOS Keychain, or the keyring on Linux. Where there is neither, such as on Windows or a headless Linux server, the key is in a file next to the vault that only you can read. Settings, Passwords says which one your daemon uses.

Bots' shell commands and file tools can't read the vault or its key in Auto or Manual. In Bypass a bot has no sandbox and could.

## Where bots can use them

- **Computer use**: Hexbot can't see which site the bots' computer shows, so it asks you before typing unless the bot uses Bypass. Look at the computer before you allow it.
- Passwords work in a bot's own chat and in its scheduled jobs. A scheduled job can use a saved password but can't show the Sign in card. Rooms and conversations between bots can't use passwords.

A page's own scripts can read a field after it is filled, and a bot set on finding a password could still get it. Give each password only to bots that need it.
