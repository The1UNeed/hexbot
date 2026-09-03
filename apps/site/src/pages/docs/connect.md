---
layout: ../../layouts/Docs.astro
title: Hexbot Connect
description: Reach a self-hosted Hexbot daemon without opening a router port.
---

# Hexbot Connect

Hexbot Connect is the optional service at `hexbot.app` for reaching your daemon outside its local network. It creates a Cloudflare Tunnel from the daemon to a private hostname. LAN pairing and [Tailscale](/docs/tailscale/) work without Connect.

## Register a daemon

Run:

```sh
hexbot connect
```

The command prints a web address and an eight-character code. Open the address, sign in, and approve the code. The daemon then stores its Connect credentials in `~/.hexbot/connect.json` and starts its tunnel whenever `hexbot serve` runs.

Use `hexbot connect status` to inspect the registration and tunnel. Use `hexbot connect disconnect` to stop the connection, remove the local credentials, and revoke the registration.

## Sign in from the app

Open Settings, choose Connect, and sign in through your system browser. The browser returns to Hexbot, where you can select one of your registered daemons. The app receives a short-lived grant, exchanges it directly with that daemon for a normal revocable device token, and then connects over TLS.

The daemon owner can revoke that device as with a LAN-paired device.

## What Connect holds

Connect stores your sign-in identity, registered daemon names and hostnames, hashed service tokens, device names for signed-in clients, and recent connection times. It uses these records to list your daemons, issue short-lived login grants, and manage tunnels.

Connect never receives your conversations, bot memory, provider keys, files, tool results, or long-lived daemon device tokens. Chat traffic passes through Cloudflare's edge and the tunnel process on your daemon host. The Connect API brokers identity and the hostname; it is not the chat server.

## Self-host Connect

The Connect service is AGPL software in `apps/connect`. Running your own instance requires a Clerk application, a Postgres database such as Neon, a Cloudflare account and zone, a Cloudflare API token scoped to tunnels and DNS, and a Vercel deployment or compatible Next.js host.

You must also provide the service signing keys and configure your desktop build and daemon to use your Connect URL and hostname. Self-hosting the daemon alone does not require any of these services.
