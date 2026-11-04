---
layout: ../../layouts/Docs.astro
title: Passwords
description: Save sign-ins, SSH keys and API keys for your bots. They use them and never see them.
---

Every bot can sign in to websites, push to Git servers and call APIs for you on its computer with passwords, SSH keys and API keys you save in Hexbot. The bot never reads one: it asks Hexbot to type a password into a field, or to run a command with a key, on the bots' computer.

## Saving a password from a chat

When a bot needs to sign in somewhere and has no password for it, it shows a card in its chat with the site's name and a **Sign in** button. Choose it for fields for your username and password. What you type goes from your app to the daemon, which saves it in Passwords straight away. It never appears in the conversation, in the bot's history, or in what is sent to the model provider. The card then shows **Saved**. Choose **Not now** to tell the bot no.

If a saved password stops working, the bot shows the card again for that site so you can enter the current one.

A password saved from a card goes to every bot. Change that in Settings, Passwords.

## SSH keys

A bot that needs to reach a server or a Git host over SSH can make a key itself. Hexbot makes an Ed25519 key, saves it in Passwords and gives the bot only the public key, which it can add to GitHub's SSH keys page with your sign-in, or ask you to add. You can also add a key in Settings, Passwords: let Hexbot make one, or paste a private key you have, with its passphrase if it has one. Hexbot reads keys in the OpenSSH format, which `ssh-keygen` writes by default. For an older PEM key, run `ssh-keygen -p -f <key file>` to convert it first.

When a bot runs `ssh` or `git` with a key, Hexbot puts the key in an `ssh-agent` that lives for that one command, then stops it. The private key is never in a file or on a command line while the command runs.

## API keys

When a bot needs an API key that isn't saved, it shows a card in its chat with the service's name, the environment variable commands read the key from (such as `OPENAI_API_KEY`), and a **Get one** link when it knows where you get a key. Choose **Add key**, paste the key and choose **Save**. Like a password, it goes straight to Passwords and never into the conversation.

When a bot runs a command with the key, Hexbot sets that variable for the command only, and blanks the key out of anything the command prints. You can add keys in Settings, Passwords too, and change the variable there.

## Settings, Passwords

Open Settings, Passwords to see every saved login, SSH key and API key. From there you can:

- add a login, with an optional one-time code key (the setup key or `otpauth://` link from a site's two-factor setup), so bots can enter the six-digit code too;
- add an SSH key, or an API key and its variable;
- show or copy a password, a private key or an API key, and copy an SSH key's public key;
- edit an item's name, notes and the rest of its details;
- choose which bots can use each item, or give it to every bot, including bots you add later;
- delete an item.

In the mobile app, open your initials, then Passwords.

Your primary bot can do the same from its own chat, without seeing any secret: it can tell you which bots have an item, give one to a bot, rename it, or delete it. Deleting always asks you first.

## Where passwords are kept

Passwords and keys are kept on the daemon's computer in one [KeePass](https://keepass.info) (KDBX 4) file per person, `~/.hexbot/users/<you>/passwords/passwords.kdbx`. The format is open, so you can open the file with [KeePassXC](https://keepassxc.org) or any KeePass app. The file is encrypted with a random key kept in the macOS Keychain, or the keyring on Linux. Where there is neither, such as on Windows or a headless Linux server, the key is in a file next to the vault that only you can read. Settings, Passwords says which one your daemon uses.

Bots' shell commands and file tools can't read the vault or its key in Auto or Manual. In Bypass a bot has no sandbox and could.

## Keeping them in Vaultwarden

If you run [Vaultwarden](https://github.com/dani-garcia/vaultwarden), or use any Bitwarden-compatible server, your bots can use the items there instead. Your Bitwarden apps then see and edit the same logins and keys.

1. Install the official Bitwarden CLI on the daemon's computer: `npm install -g @bitwarden/cli`, or `brew install bitwarden-cli` on a Mac.
2. In Settings, Passwords, under **Where they're kept**, choose **Use Vaultwarden**.
3. Enter the server's https address, your email and your master password. If the account uses two-step login, Hexbot asks for the code from your authenticator app.
4. Choose whether to copy the items already saved on the daemon, then **Connect**.

Hexbot makes a **Hexbot** folder in the account and uses only the items in it. To give your bots a login you already have, move it into that folder in a Bitwarden app. Logins and API keys are Login items; SSH keys are Secure notes with the private key in a hidden field. Deleting an item in Hexbot moves it to Vaultwarden's trash.

Hexbot keeps your master password in the keychain of the daemon's computer, or the key file, so it can unlock after a restart. While unlocked, the Bitwarden CLI can read the whole account, so an account just for your bots is safest. **Disconnect** signs out and goes back to the passwords saved on the daemon; nothing in Vaultwarden is deleted.

## Where bots can use them

- **Computer use**: Hexbot can't see which site the bots' computer shows, so it asks you before typing unless the bot uses Bypass. Look at the computer before you allow it.
- **Commands with keys**: Hexbot can't see where a command sends a key, so it asks you before running one with an SSH key or an API key unless the bot uses Bypass. The card names the keys and shows the command. Read it before you allow it.
- Passwords and keys work in a bot's own chat and in its scheduled jobs. A scheduled job can use them but can't show a card. Rooms and conversations between bots can't use them.

A page's own scripts can read a field after it is filled, a command can print or send a key it was given, and a bot set on finding a password or key could still get it. Give each item only to bots that need it.
