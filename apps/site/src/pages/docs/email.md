---
layout: ../../layouts/Docs.astro
title: Email
description: Let bots read Gmail or Outlook and draft email you edit and send.
---

The **Google Workspace** and **Microsoft 365** connectors let a bot read your Gmail or Outlook and draft email for you. A bot never sends email by itself: it shows you a draft in its chat, and you send it.

## Sign in

Open **Settings**, **Plugins**, and choose **Google Workspace** or **Microsoft 365**, then **Sign in**. You sign in once on the daemon, and then choose the bots that get it, as with any plugin.

- **Microsoft** shows a code. Choose **Copy code and open Microsoft**, paste the code there, and sign in. Hexbot sees the sign-in finish on its own.
- **Google** opens its own page. When your browser runs on the daemon's computer, as with the Full app, Google comes back to Hexbot by itself. When the daemon is on another computer, or you sign in from your phone, Google ends on a page that doesn't load. Copy that page's address, paste it into Hexbot, and choose **Finish**.

Hexbot keeps the sign-in on the daemon, in a file bots can't open unless they run in Bypass, which has no sandbox. The bot asks Hexbot to read or draft, and Hexbot makes the request; the bot never sees your password or the sign-in itself. **Sign out** in the same place removes it, and at Google withdraws it too.

## What a bot can do

- **Search** your mail with the service's own search words, such as `from:ana is:unread` in Gmail, and **read** a message as plain text. Reading needs no approval.
- **Draft** an email or a reply. The draft appears in the bot's chat as a card with To, Cc, Bcc, Subject and the message. Change anything you like, then choose **Send**, or **Save draft** to finish it in Gmail or Outlook later. **Discard** sends nothing. To have the bot rewrite it, discard it and ask in the chat.

A draft card asks in every approval mode, Bypass included: only you can send. The card says **Sent** once Gmail or Outlook has the email. If it refuses, the card says why and keeps your changes, so you can try again. A reply stays in its thread. The bot is told what you sent, after your changes.

Email bots read was written by other people. Bots treat it as information, not instructions, but read a draft before you send it.

Bots read and draft email in their own chat and in scheduled jobs. Rooms, threads between bots and heartbeats don't get your mailbox. A scheduled job can read but not draft, since nobody is there to answer the card.

## Your own OAuth client

Official builds sign in through Hexbot's own apps at Google and Microsoft. Some Google Workspace organisations allow only apps they approve. In that case, or in a build without Hexbot's apps, choose **Use your own OAuth client** when you set it up:

- **Google**: a **Desktop app** client from Google Cloud, with the Gmail API enabled. Paste its client ID and client secret.
- **Microsoft**: an app in Microsoft Entra with **Allow public client flows** on and the delegated permissions `User.Read`, `Mail.ReadWrite` and `Mail.Send`. Paste its application (client) ID.

Save it, then sign in.
