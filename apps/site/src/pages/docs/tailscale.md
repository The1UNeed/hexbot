---
layout: ../../layouts/Docs.astro
title: Tailscale
description: Connect to a Hexbot daemon over Tailscale.
---

Tailscale is the recommended first way to reach your daemon outside your LAN. It creates a private network between your devices, so you do not need to expose a router port.

## Set it up

1. Install Tailscale on the daemon computer and the client computer.
2. Sign both devices into the same tailnet, or share the daemon device through Tailscale.
3. Enable "Allow other devices" in Hexbot's network settings.
4. On the daemon computer, run `hexbot pair` to create a fresh code.
5. Pair using the daemon's Tailscale IP address or MagicDNS name and its Hexbot port.

The daemon uses plain WebSocket traffic. Tailscale encrypts traffic between tailnet devices. Do not use the same setup over the public internet without a private network or secure proxy.

## Access rules

Tailscale access control lists can restrict who reaches the daemon. Allow only the people and devices that need the Hexbot port. Hexbot pairing still applies after the network connection succeeds, so each desktop app needs its own device token.

## If it does not connect

Run `tailscale status` on both computers. Confirm that the daemon's Tailscale address responds and that your tailnet policy permits the port. Then check Hexbot's LAN setting and generate a new pairing code.

Hexbot Connect will offer a managed remote path later. Tailscale works without Hexbot Connect and keeps the route under your control.
