---
layout: ../../layouts/Docs.astro
title: Providers and billing
description: Configure model providers and understand model charges.
---

Hexbot runs the agent. Model providers run the models. You bring provider credentials and the provider bills your account for usage. Hexbot does not include model tokens or pay those charges.

## Add a provider

Open provider settings and choose a provider. Providers come in two kinds:

- **Subscription** providers (ChatGPT or Codex, SuperGrok, Nous Portal) sign you in through your browser. Hexbot shows a short code, opens the provider's device page, and waits until you finish. No key to paste.
- **API key** providers take a key from your account with them. Hexbot checks the key by listing that provider's models before saving it.

Credentials belong to the daemon deployment, not to one bot. Every bot on that daemon may use any configured provider. Setup walks you through the first provider and then lets you add more before it asks for a default.

## Default and fallback models

Provider settings also hold two deployment-wide choices. The **default model** is pre-filled whenever you create a bot. The optional **fallback** is the model every bot switches to when its own provider is down or rate limited.

Treat provider keys like passwords. Do not paste them into a chat, a bot persona, or a project file. Hexbot stores credentials in the daemon's private configuration.

## Choose a model

Each bot has a provider and model. The picker combines a short curated list with models reported by configured providers. A section can also carry a temporary model override.

Model names, prices, context limits, and availability can change. Check the provider's own pricing page before using an unfamiliar model or enabling long unattended tasks.

## Understand charges

Providers commonly charge for input and output tokens. Tool results, conversation history, memory, and long files can increase input size. A bot that calls many tools may make several model requests for one visible answer.

Hexbot does not add a fee to provider requests. Your provider dashboard is the source of truth for invoices and quotas.

## Remove access

Clear a provider key, or sign out of a subscription provider, in settings to stop new requests through that provider. Bots configured for it will need another model before they can reply.
