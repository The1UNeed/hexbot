---
layout: ../../layouts/Docs.astro
title: Hexbot Connect
description: Reach a self-hosted Hexbot daemon without opening a router port.
---


Hexbot Connect is the optional service at `connect.hexbot.app` for reaching your daemon outside its local network. It creates a Cloudflare Tunnel from the daemon to a hostname of the form `amber-otter-1234.hexbot.app`. LAN pairing and [Tailscale](/docs/tailscale/) work without Connect.

## Register a daemon

Run:

```sh
hexbot connect
```

The command prints a web address and an eight-character code. Open the address, sign in, and approve the code. The daemon then stores its Connect credentials in `~/.hexbot/connect.json` and starts its tunnel whenever `hexbot serve` runs. Registering from the app's Connect settings while the daemon is running starts the tunnel straight away.

The tunnel follows the daemon's port: each heartbeat reports the port `hexbot serve` is listening on, and Connect points the tunnel at it.

Use `hexbot connect status` to inspect the registration and tunnel. Use `hexbot connect disconnect` to stop the connection, remove the local credentials, and revoke the registration. Revocation is best effort when Connect is unreachable; you can also revoke a daemon from the daemon list at `connect.hexbot.app`.

## Sign in from the app

Open Settings, choose Connect, and sign in through your system browser. The browser returns to Hexbot, where you can select one of your registered daemons. The app receives a short-lived grant, exchanges it directly with that daemon for a normal revocable device token, and then connects over TLS.

The daemon owner can revoke that device as with a LAN-paired device.

## What Connect holds

Connect stores your sign-in identity, registered daemon names and hostnames, hashed service tokens, device names for signed-in clients, and recent connection times. It uses these records to list your daemons, issue short-lived login grants, and manage tunnels.

Connect never receives your conversations, bot memory, provider keys, files, tool results, or long-lived daemon device tokens. Chat traffic passes through Cloudflare's edge and the tunnel process on your daemon host. The Connect API brokers identity and the hostname; it is not the chat server.

## Self-host Connect

The Connect service is AGPL software in `apps/connect`. Running your own instance requires a Clerk application, a Postgres database such as Neon, a Cloudflare account and zone, a Cloudflare API token scoped to tunnels and DNS, and a Vercel deployment or compatible Next.js host.

You must also provide the service signing key. Point a daemon at your instance with the `HEXBOT_CONNECT_URL` environment variable before running `hexbot connect` and `hexbot serve`. Point the app at it by setting `hexbot.connect.url` in the web bundle's local storage, or `VITE_HEXBOT_CONNECT_URL` when building the bundle. Self-hosting the daemon alone does not require any of these services.

See `apps/connect/README.md` in the repository for the deployment checklist.
