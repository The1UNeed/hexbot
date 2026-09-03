---
layout: ../../layouts/Docs.astro
title: Providers and billing
description: Configure model providers and understand model charges.
---

# Providers and billing

Hexbot runs the agent. Model providers run the models. You bring provider credentials and the provider bills your account for usage. Hexbot does not include model tokens or pay those charges.

## Add a provider

Open provider settings, choose a provider, and save its API key or supported account credential. Credentials belong to the daemon deployment, not to one bot. Every bot on that daemon may use any configured provider.

Treat provider keys like passwords. Do not paste them into a chat, a bot persona, or a project file. Hexbot stores credentials in the daemon's private configuration.

## Choose a model

Each bot has a provider and model. The picker combines a short curated list with models reported by configured providers. A section can also carry a temporary model override.

Model names, prices, context limits, and availability can change. Check the provider's own pricing page before using an unfamiliar model or enabling long unattended tasks.

## Understand charges

Providers commonly charge for input and output tokens. Tool results, conversation history, memory, and long files can increase input size. A bot that calls many tools may make several model requests for one visible answer.

Hexbot does not add a fee to provider requests. Your provider dashboard is the source of truth for invoices and quotas.

## Remove access

Clear a provider key in settings to stop new requests through that provider. Bots configured for it will need another model before they can reply.
