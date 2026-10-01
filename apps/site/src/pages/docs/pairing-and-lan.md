---
layout: ../../layouts/Docs.astro
title: Pairing and LAN
description: Pair a Hexbot desktop app with a daemon on your local network.
---

A fresh daemon listens only on its own computer. Turn on "Allow other devices" before pairing over your local network.

## On the daemon computer

Open network settings and enable LAN access, or run:

```sh
hexbot pair
```

Hexbot shows the daemon's local addresses, a short code, and a QR or pairing link. The code expires after ten minutes and works once. The address list includes every active IPv4 interface, so choose the LAN address
when a VPN or Tailscale address also appears.

Enabling LAN access makes the daemon listen on all network interfaces. Your router still decides whether devices can reach one another. Guest Wi-Fi networks often block local device traffic.

Turning LAN access on or off moves the daemon to its new address without restarting it. Open apps and browsers reconnect, and running bot turns continue.

## On the other computer

Open the pairing link in a browser, then choose "Open in Hexbot." You can also open Hexbot, choose "Connect to a daemon," and enter the host, port, and code by hand.

The app exchanges the one-time code for a device token. It stores that token locally and presents it on later connections. The pairing code itself is not reused.

## Revoke a device

The daemon owner can view paired devices in settings and revoke any device. Revocation invalidates its token. Pair that device again if you want to restore access.

## Troubleshooting

- Confirm both computers are on the same network.
- Use the numeric LAN address if a `.local` hostname does not resolve.
- Check the daemon port and local firewall.
- Generate a new code if ten minutes have passed.
- Do not forward the daemon port on your router. Use [Tailscale](/docs/tailscale/) for remote access.

## Browser on the daemon computer

A daemon started by hand in a terminal (`hexbot serve`) prints a one-time
sign-in link when it starts. Open it in a browser on the same computer: it
works once, expires after ten minutes, and keeps that browser signed in. Open
the link from the terminal or paste it into the address bar; a link followed
from another website shows the sign-in page instead, where you can enter its
code. A browser that is already signed in stays on its session. For
another browser, run `hexbot pair` and enter the code on the sign-in page, or
use the Hexbot app, which signs in on its own. A daemon run by the app, as a
service, or with its output in a log prints no link; use a pairing code there.

If you serve the browser through an HTTPS reverse proxy, set
`dashboard.public_url` to that public address and preserve its Host header.
Browser session cookies then require HTTPS, including when the proxy runs on
another LAN host.
