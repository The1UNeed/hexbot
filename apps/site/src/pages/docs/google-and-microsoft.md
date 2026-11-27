---
layout: ../../layouts/Docs.astro
title: Google and Microsoft
description: Connect Gmail, Google Calendar, Google Drive, Docs, Sheets, Slides and Tasks, or Microsoft Outlook, OneDrive, Word, Excel, PowerPoint and To Do.
---

Hexbot has a connector for each Google and Microsoft service. You connect the ones you want, and a bot reaches only the ones you turn on for it.

| Google | Microsoft | What a bot can do |
| --- | --- | --- |
| Gmail | Outlook | Search and read your mail, and draft email that you send. See [Email](/docs/email/). |
| Google Calendar | Outlook Calendar | See your events, and add, change or delete them. |
| Google Drive | OneDrive | Find and read any file, download one to work on, and add new files. |
| Google Docs | Word | Find and read documents, write new ones, add to one, and replace text. |
| Google Sheets | Excel | Find and read spreadsheets, make new ones, write cells and add rows. |
| Google Slides | PowerPoint | Find and read presentations, make new ones, add slides, and replace text. |
| Google Tasks | Microsoft To Do | See your task lists, and add, change, complete or delete tasks. |

## Connect one

Open **Settings**, **Plugins**. Under **Google** or **Microsoft**, choose **Connect** on the connector you want. The window that opens shows what bots can do with it and asks three things:

- **Bots that get it.** Your primary bot is chosen; change it as you like.
- **Connect with the same sign-in.** Tick any other connectors of the same account to connect them at the same time. Google then shows one screen that lists each of them; leave a box unticked there and that connector stays not connected.
- **Sign in.**
  - **Google** opens its own page. When your browser runs on the daemon's computer, as with the Full app, Google comes back to Hexbot by itself. When the daemon is on another computer, or you sign in from your phone, Google ends on a page that doesn't load. Copy that page's address, paste it into Hexbot, and choose **Finish**.
  - **Microsoft** shows a code. Choose **Copy code and open Microsoft**, paste the code there, and sign in. Hexbot sees the sign-in finish on its own.

Each connector asks Google or Microsoft only for what it needs. Google Calendar can't read your mail, and Gmail can't see your files. Connectors you connect in one sign-in are allowed together at Google; Hexbot still uses each for its own job only.

Connected connectors move to **Connected** at the top of the page, with the account they use and the bots that have them. Open one to switch it on or off for each bot, test it, or disconnect it.

Hexbot keeps each sign-in on the daemon, in a file bots can't open unless they run in Bypass, which has no sandbox. A bot asks Hexbot to read or change something, and Hexbot makes the request; the bot never sees your password or the sign-in itself.

**Disconnect** removes one connector's sign-in and leaves the others. When you disconnect the last Google connector of an account, Hexbot also withdraws its access at Google.

If a sign-in stops working, the connector shows **Sign in again**. Choose **Fix** and sign in; the bots that had it keep it.

## What asks first

Reading, searching and downloading run in every approval mode. A change follows the bot's [approval mode](/docs/approvals/):

- **Auto** checks each change first. Routine ones run; anything risky asks you.
- **Manual** asks every time.
- **Bypass** runs it.

Email is stricter: only you send, from the draft card, in every mode.

When a bot adds, changes or deletes an event with guests, the calendar itself emails them. To delete an event or a task, a bot has to name its title as well as pick it, so the request you approve says what goes.

What a bot reads in your mail, calendar and files was written by other people. Bots treat it as information, not instructions.

Bots use these connectors in their own chat and in scheduled jobs. Rooms, threads between bots and heartbeats don't get them. In a scheduled job nobody is there to answer, so a change runs only in Bypass.

## Files

- **Google Drive** lets a bot read every file but change only the ones Hexbot added. New files go to the top of My Drive.
- **OneDrive** lets a bot add files and replace one with a new version. OneDrive keeps the earlier versions.
- Microsoft has one permission for files, so Word, Excel and PowerPoint each ask for the same access as OneDrive. Hexbot's Word connector still opens only Word files, and so on for the others.
- A bot downloads a file into its chat's own files, works on it there, and uploads the result. Google documents, sheets and slides download as Word, Excel and PowerPoint files.
- Credential files, such as `.env`, are never uploaded.

## Word, Excel and PowerPoint

Hexbot reads and changes these files itself, for personal and work accounts alike. It changes only what you asked for and leaves the rest of the file as it was, and it won't write over a file that changed or is open for editing elsewhere; close it there and ask again.

- A new document comes from the bot's Markdown: headings, lists, tables, bold, italic and links carry over.
- Replaced text takes the style of the place where the match began. The rest of the paragraph, its line breaks and its links stay as they were.
- In an Excel workbook, a formula's result updates when you next open the workbook in Excel.
- For anything else, such as restyling or moving things, a bot downloads the file, edits it with a skill, and uploads the next version. That needs OneDrive connected too.

## Your own OAuth client

Official builds sign in through Hexbot's own apps at Google and Microsoft. Some organisations allow only apps they approve. In that case, or in a build without Hexbot's apps, choose **Use your own OAuth client** when you connect a connector. One client serves every connector of that account.

- **Google**: a **Desktop app** client from Google Cloud, with the APIs of the services you connect enabled: Gmail, Google Calendar, Google Drive, Google Docs, Google Sheets, Google Slides, Tasks. Paste its client ID and client secret.
- **Microsoft**: an app in Microsoft Entra with **Allow public client flows** on and the delegated permissions of the services you connect: `User.Read` for all; `Mail.ReadWrite` and `Mail.Send` for Outlook; `Calendars.ReadWrite` and `MailboxSettings.Read` for Outlook Calendar; `Files.ReadWrite` for OneDrive, Word, Excel and PowerPoint; `Tasks.ReadWrite` and `MailboxSettings.Read` for Microsoft To Do. Paste its application (client) ID.

Save it, then sign in.

## From Google Workspace and Microsoft 365

Earlier versions had one **Google Workspace** connector and one **Microsoft 365** connector, which did mail only. They are now **Gmail** and **Outlook**. Your sign-in and the bots that had them carry over; connect the other services when you want them.

## Trademarks

Google, Gmail, Google Calendar, Google Drive, Google Docs, Google Sheets, Google Slides and Google Tasks are trademarks of Google LLC. Microsoft, Outlook, OneDrive, Word, Excel, PowerPoint and Microsoft To Do are trademarks of the Microsoft group of companies. Hexbot is not affiliated with, sponsored by or endorsed by Google or Microsoft.
