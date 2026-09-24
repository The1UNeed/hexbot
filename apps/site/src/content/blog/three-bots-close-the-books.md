---
title: Three bots, one studio, and a month of sales
description: We gave three Hexbot bots two spreadsheets from a made-up ceramics studio and asked how September went. Here is what they did, mistakes included.
date: 2026-09-24
image: /screens/room.webp
---

We wanted a screenshot for the new website that wasn't staged. So we installed a fresh nightly, made up a ceramics studio, and gave three bots a real job.

## The setup

The studio belongs to Maya, who sells mugs, vases, and bowls at two markets and online. Her About you text said that, and asked for short answers in NZD.

Then we made three bots:

- **Scout**, a blue circle, runs the studio desk.
- **Ledger**, a green hexagon, keeps the books.
- **Juniper**, a pink drop, writes the shop copy and the newsletter.

Each new bot opens by interviewing you. Ledger asked what it was mainly for and offered four answers. We typed our own. After three questions it rewrote its own soul and saved its first memories.

![Ledger asking what it should mainly be used for, with four suggested answers.](/screens/clarify.webp)

The data was two CSV files in a folder: September sales, 13 rows across three channels, and five supplier invoices. One invoice was entered twice on purpose.

## The ask

We put all three bots in a room called Studio, with Scout as the main bot, and wrote one message:

> @Ledger how did September go? The sales and supplier invoices are in /tmp/Studio. @Juniper once Ledger has the numbers, write two lines for the October newsletter about our best seller.

## What happened

Juniper didn't wait. It read the sales file itself and wrote the two lines about the speckled mug, then tagged Ledger to fill in exact figures.

Ledger's first totals were wrong. It recomputed by date, by channel, and by item, found the mistake, and posted a correction table. It also checked Juniper's work and pushed back on one claim. Juniper had said the mug showed up in more sales rows than everything else combined, and it was in 5 of 13. Ledger pointed out that it did win on units, 64 against 40, and on dollars. Juniper agreed, dropped the claim, and rewrote the line with "sixty-four" in it, because dollar figures read like Ledger's column, not a newsletter.

A follow-up asked for one short table. Ledger gave it, and Scout rechecked the sums before taking the next job.

| September | NZD |
| --- | --- |
| Harbourside Market | 2,290 |
| Online shop | 1,492 |
| Night Market | 861 |
| Sales total | 4,643 |
| Still owe suppliers | 867.70 |

We checked every number by hand afterwards. They're right, and Ledger counted the duplicate invoice once and said so.

## What we'd tell you

The interesting part isn't that the bots got it right first time. They didn't. The interesting part is that they caught each other in the open, in a room Maya could read, and the final answer was correct.

A few honest notes. The bots ran on GLM 5.3 through OpenCode Go. We turned approvals off for this run so nobody had to sit and click. Ledger's first message in the room stopped halfway through a thought, and we sent the follow-up to get a clean table for the screenshot. The screenshot on our home page is that room, unedited.

![The Studio room with Ledger's table and Scout's check.](/screens/room.webp)

Want to try it yourself? Hexbot is in [nightly early access](/blog/nightly-early-access/) for Mac and Linux.
