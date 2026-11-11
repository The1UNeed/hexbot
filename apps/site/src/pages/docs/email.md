---
layout: ../../layouts/Docs.astro
title: Email
description: Let bots read Gmail or Outlook and draft email you edit and send.
---

The **Gmail** and **Outlook** connectors let a bot read your mail and draft email for you. A bot never sends email by itself: it shows you a draft in its chat, and you send it.

## Connect

Open **Settings**, **Plugins**, choose **Gmail** or **Outlook**, and sign in. [Google and Microsoft](/docs/google-and-microsoft/) explains signing in, the other connectors of the same account, and how to disconnect one.

## What a bot can do

- **Search** your mail with the service's own search words, such as `from:ana is:unread` in Gmail, and **read** a message as plain text. Reading needs no approval.
- **Draft** an email or a reply. The draft appears in the bot's chat as a card with To, Cc, Bcc, Subject and the message. Change anything you like, then choose **Send**, or **Save draft** to finish it in Gmail or Outlook later. **Discard** sends nothing. To have the bot rewrite it, discard it and ask in the chat.

A draft card asks in every approval mode, Bypass included: only you can send. The card says **Sent** once Gmail or Outlook has the email. If it refuses, the card says why and keeps your changes, so you can try again. A reply stays in its thread. The bot is told what you sent, after your changes.

Email bots read was written by other people. Bots treat it as information, not instructions, but read a draft before you send it.

Bots read and draft email in their own chat and in scheduled jobs. Rooms, threads between bots and heartbeats don't get your mailbox. A scheduled job can read but not draft, since nobody is there to answer the card.

## Your own OAuth client

Some organisations allow only apps they approve. [Google and Microsoft](/docs/google-and-microsoft/#your-own-oauth-client) explains how to sign in with a client of your own.
