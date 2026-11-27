---
layout: ../../layouts/Docs.astro
title: Email
description: Let bots read Gmail, Outlook or any other mailbox and draft email you edit and send.
---

The **Gmail**, **Outlook** and **IMAP mail** connectors let a bot read your mail and draft email for you. A bot never sends email by itself: it shows you a draft in its chat, and you send it.

## Connect

Open **Settings**, **Plugins**, choose **Gmail** or **Outlook**, and sign in. [Google and Microsoft](/docs/google-and-microsoft/) explains signing in, the other connectors of the same account, and how to disconnect one.

### Any other mailbox

**IMAP mail** connects any mailbox that offers IMAP and SMTP, such as iCloud Mail, Fastmail, Yahoo Mail, Zoho, GMX, mailbox.org, Posteo or your own server. Open **Settings**, **Plugins**, choose **IMAP mail**, and enter:

- **Email address**: the address you send from.
- **App password**: most services want a password made for Hexbot in their security settings, not the one you sign in with. iCloud, Yahoo, Fastmail and Gmail all require one.

Hexbot knows the servers of the services above. For any other, open **Show advanced** and enter the **IMAP server** and **SMTP server**, such as `imap.example.com:993` and `smtp.example.com:465`. Ports 143, 587, 25 and 2525 use STARTTLS; any other port uses TLS from the start. Add a **User name** if it isn't your address. **Connect and test** signs in to both servers before it saves.

Every connection uses TLS with a valid certificate. A bridge on the daemon's own computer, such as Proton Mail Bridge at `127.0.0.1:1143` and `127.0.0.1:1025`, may use its own certificate, since nothing leaves the computer. Outlook.com no longer accepts app passwords over IMAP: use the Outlook connector for it.

To give one bot a different mailbox, set up IMAP mail from that bot's settings and choose **Use a different value for this bot only**.

## What a bot can do

- **Search** your mail with the service's own search words, such as `from:ana is:unread` in Gmail, and **read** a message as plain text. Reading needs no approval and never marks a message read. IMAP mail takes `from:`, `to:`, `cc:`, `subject:`, `is:unread`, `is:read`, `is:starred`, `after:` and `before:` with a date such as `2026-03-01`, `in:` with a folder such as `sent`, `drafts` or `archive`, and plain words. A `-` in front leaves out what it matches.
- **Draft** an email or a reply. The draft appears in the bot's chat as a card with To, Cc, Bcc, Subject and the message. Change anything you like, then choose **Send**, or **Save draft** to finish it in your mail app later. **Discard** sends nothing. To have the bot rewrite it, discard it and ask in the chat.

A draft card asks in every approval mode, Bypass included: only you can send. The card says **Sent** once your mail service has the email. IMAP mail sends with SMTP and puts a copy in your Sent folder; **Save draft** puts it in your Drafts folder. If it refuses, the card says why and keeps your changes, so you can try again. A reply stays in its thread. The bot is told what you sent, after your changes.

Email bots read was written by other people. Bots treat it as information, not instructions, but read a draft before you send it.

Bots read and draft email in their own chat and in scheduled jobs. Rooms, threads between bots and heartbeats don't get your mailbox. A scheduled job can read but not draft, since nobody is there to answer the card.

## Your own OAuth client

Some organisations allow only apps they approve. [Google and Microsoft](/docs/google-and-microsoft/#your-own-oauth-client) explains how to sign in with a client of your own.
