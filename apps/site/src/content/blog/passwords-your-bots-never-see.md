---
title: Passwords your bots never see
description: When a bot needs to sign in to a website, it shows a card in its chat. What you type is saved in Settings, Passwords and typed into the page for it. The bot never reads it.
date: 2026-10-31
---

Some jobs start with a sign-in: a supplier's portal, a market's booking site, a school's homework page. Until today, the only way to get a password to a bot was to paste it into the chat, where it stayed in the history and went to the model provider.

Starting with today's nightly, there's a better way.

## A Sign in card

When a bot needs to sign in and has no password for the site, it shows a **Sign in** card in its chat. What you type goes from your app straight to the daemon and is saved in **Settings, Passwords**. It never appears in the conversation, the bot's history, or anything sent to the model.

When the bot needs it, it asks Hexbot to type the password into the page. In the bot's browser, Hexbot types only when the page is on that login's site. On the bots' computer, Hexbot can't tell which site is showing, so it asks you first unless the bot uses Bypass. Six-digit codes from an authenticator work too.

## Settings, Passwords

Every saved sign-in is listed in Settings, Passwords, in the app, the browser, and on your phone. Add one, show or copy it, edit it, delete it, and choose which bots may use it. A password saved from a card goes to every bot until you change that. Your primary bot can manage them from its own chat, without seeing a password, and deleting always asks you.

Passwords are kept in one [KeePass](https://keepass.info) file per person on the daemon's computer, so you can open it with KeePassXC. Its key is in the macOS Keychain or the Linux keyring, or a file only you can read. Bots' commands can't read either in Auto or Manual. See [Passwords](/docs/passwords/).

## Also in recent nightlies

- **Long chats and rooms are fast.** A bot in a 3,000-message room now starts answering in about 30 ms instead of 1.4 s. While a bot replies, only its own bubble redraws, and rooms open on their latest messages with a **Load earlier messages** button.
- **Math shows as formulas** instead of bare brackets.
- **The iPhone beta.** The iPhone app is on [TestFlight](https://testflight.apple.com/join/byKAKWMW), and the download page now links to it.
