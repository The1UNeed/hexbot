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

Treat provider keys like passwords. Do not paste them into a chat, a bot persona, or a project file. Hexbot stores credentials in the daemon's private configuration. Replacing a provider key updates open sections before their next provider request.

## Choose a model

Each bot has a provider and model. The picker combines a short curated list with models reported by configured providers. A section can also carry a temporary model override.

Each bot also has a reasoning level, from Off to Max, in its Model settings. Higher levels think longer before answering and use more tokens. The default is Medium. A model uses the closest level it supports, and models without reasoning ignore it. Choose it under Change when you create a bot, so the bot's first section starts at that level. A new level applies to new sections; open sections keep the level they started with.

LM Studio lists the models available at its local `/v1/models` endpoint when you open its model picker. Start LM Studio's server before choosing a model. If discovery fails, the daemon's current configured model stays in the list.

Model names, prices, context limits, and availability can change. Check the provider's own pricing page before using an unfamiliar model or enabling long unattended tasks.

## Understand charges

Providers commonly charge for input and output tokens. Tool results, conversation history, memory, and long files can increase input size. A bot that calls many tools may make several model requests for one visible answer.

Hexbot does not add a fee to provider requests. Your provider dashboard is the source of truth for invoices and quotas.

## Remove access

Clear a provider key, or sign out of a subscription provider, in settings to stop new requests through that provider, including requests from open sections. Bots configured for it will need another model before they can reply.
