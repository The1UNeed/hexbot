---
layout: ../../layouts/Docs.astro
title: Hex Connect
description: Reach a self-hosted Hexbot daemon from anywhere, in the app or a browser, without opening a router port.
---

Hex Connect is the optional service at [connect.hexbot.app](https://connect.hexbot.app) for reaching your daemon outside its local network. It gives the daemon a Cloudflare Tunnel and a hostname of 16 random characters, and it signs you in so your devices can prove they are yours. Chat traffic goes from your device to your daemon through the tunnel and never through Connect's servers. Cloudflare decrypts it at its edge to route it, so for traffic Cloudflare cannot see, use LAN pairing or Tailscale. LAN pairing and [Tailscale](/docs/tailscale/) work without it. Connect is free during the beta.

## Create an account

Go to [connect.hexbot.app](https://connect.hexbot.app) and create an account with an email address, a passkey, or a Google or GitHub account. One account owns any number of daemons and signs in from any number of devices.

## Register a daemon

On the machine that runs your bots, run:

```sh
hexbot connect
```

It prints an address and an eight-character code. Open the address, sign in, and approve the code. The daemon stores its Connect credentials in `~/.hexbot/connect.json`, starts its tunnel whenever `hexbot serve` runs, and reports in every five minutes so the Connect page can show whether it is online. Give the daemon a different name with `hexbot connect --name "Studio Mac"`. A daemon installed without the desktop app needs Node.js 24 or newer for Connect. A daemon registered before owner pinning ignores its old registration and asks you to run `hexbot connect` again.

You can also register from the app: open Settings, choose Connect, and press **Sign in and register**. The app shows the same code and starts the tunnel as soon as you approve it.

`hexbot connect status` shows the registration and tunnel. `hexbot connect disconnect` stops the tunnel, removes the local credentials, and revokes the registration. You can also revoke a daemon from your daemons page at connect.hexbot.app; revocation deletes its tunnel, and the daemon keeps working on its own network.

## Open a daemon in a browser

On your daemons page, press **Open in browser** next to an online daemon. Connect sends the browser to the daemon, which asks Connect to confirm who you are, and you land in your rooms and sections. Nothing to install: this works on a phone, a tablet, or someone else's computer.

The browser then appears in that daemon's Settings under Devices with a name like "Safari on iPhone", and you can revoke it there like any paired device. Going straight to the daemon's address shows a sign-in page with the same **Sign in with Hex Connect** button.

## Sign in from the app

On a computer without a daemon, or in the client-only package, open Hexbot, choose **Sign in with Hex Connect**, and finish signing in in your system browser. The browser returns to Hexbot, which lists your daemons; pick one and you are connected over TLS. The app appears under **Apps signed in with your account** on connect.hexbot.app, where you can sign it out.

Behind the scenes the app receives a short-lived, single-use login grant and exchanges it directly with the daemon for a normal revocable device token. The daemon owner can revoke that device as with a LAN-paired device.

## What Connect holds

Connect stores your sign-in identity (through Clerk), the names and hostnames of your daemons, hashed service tokens, the device names of apps and browsers that signed in, and recent check-in times. It uses these records to list your daemons, issue login grants, and manage tunnels. The [privacy policy](/privacy/#connect) lists every record and how long it is kept.

Connect never receives your conversations, bot memory, provider keys, files, tool results, or long-lived device tokens. It is not in the path your chat takes. The [security policy](/security/) explains the design.

## Self-host Connect

The Connect service is AGPL software in `apps/connect`. Running your own instance requires a Clerk application, a Postgres database such as Neon, a Cloudflare account with a tunnel zone of its own, a Cloudflare API token scoped to tunnels and that zone's DNS, a service signing key, and a Vercel deployment or compatible Next.js host. PostHog is optional.

Point a daemon at your instance with the `HEXBOT_CONNECT_URL` environment variable before running `hexbot connect` and `hexbot serve`. Point the app at it by setting `hexbot.connect.url` in the web bundle's local storage, or `VITE_HEXBOT_CONNECT_URL` when building the bundle. Self-hosting the daemon alone does not require any of these services.

See `apps/connect/README.md` in the repository for the deployment checklist.
