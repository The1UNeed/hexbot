---
layout: ../../layouts/Docs.astro
title: Providers and billing
description: Configure model providers and understand model charges.
---

Hexbot runs the agent. Model providers run the models. You bring provider credentials and the provider bills your account for usage. Hexbot does not include model tokens or pay those charges.

## Add a provider

Open Settings, Providers and choose a provider. On a shared daemon, an admin manages these credentials.

- **Subscription** providers, including ChatGPT or Codex, SuperGrok, and Nous Portal, sign you in through your browser. Follow the provider's sign-in page and enter the displayed code if it asks for one.
- **API key** providers take a key from your account with them. Hexbot saves the key for the daemon. A saved key does not guarantee that your account can use every model in the list; send a short test message after choosing one.
- Local or externally managed providers may require endpoint or credentials configuration on the daemon computer. Follow the setup message shown for that provider.

Credentials belong to the daemon deployment, not to one bot. Every bot on that daemon may use any configured provider. Setup walks you through the first provider and then lets you add more before it asks for a default.

## Default and fallback models

Provider settings also hold two deployment-wide choices. The **default model** is pre-filled whenever you create a bot. The optional **fallback** is the model every bot switches to when its own provider is down or rate limited.

Treat provider keys like passwords. Do not paste them into a chat, a bot persona, or a project file. Hexbot stores credentials in the daemon's private configuration. Replacing a provider key updates open sections before their next provider request.

## Choose a model

Each bot has a provider and model. The picker combines a short curated list with models reported by configured providers. A section can also carry a temporary model override.

LM Studio lists the models available at its local `/v1/models` endpoint when you open its model picker. Start LM Studio's server before choosing a model. If discovery fails, the daemon's current configured model stays in the list.

## Local and custom servers

Start the model server on the daemon computer, or at an address that computer can reach. `localhost` means the daemon's computer, even when your client app runs elsewhere.

For an OpenAI-compatible custom server, set the `model` fields in the daemon's `config.yaml`. Merge them into the existing configuration rather than replacing the whole file. For example, an Ollama server can use:

```yaml
model:
  provider: custom
  base_url: http://127.0.0.1:11434/v1
  default: your-loaded-model
```

Replace `your-loaded-model` with an actual model name on that server. Refresh provider settings and start a new section after configuration changes. For an authenticated endpoint, configure its credentials on the daemon too. Local models need the capabilities your task uses, such as tool calling or image input.

LM Studio's default endpoint is `http://127.0.0.1:1234/v1`. Start its server and load a model before selecting it in Hexbot. Use the LM Studio provider for its model discovery.

Model names, prices, context limits, and availability can change. Check the provider's own pricing page before using an unfamiliar model or enabling long unattended tasks.

## Model credentials and connectors

A model provider generates replies. Web search, cloud browser, image generation, and premium voice are separate [connectors](/docs/tools-and-skills/) with their own credentials and per-bot switches. If a bot can reply but cannot use one of those tools, check its Connectors settings instead of replacing the model key.

## Understand charges

Providers commonly charge for input and output tokens. Tool results, conversation history, memory, and long files can increase input size. A bot that calls many tools may make several model requests for one visible answer.

Hexbot does not add a fee to provider requests. Your provider dashboard is the source of truth for invoices and quotas.

Rooms, private teammate exchanges, delegated subtasks, scheduled jobs, and dreaming can all make additional model requests. Settings, Usage reports token counts and estimated costs. An admin can set [user and bot budgets](/docs/multi-user/#budgets-and-usage); estimates may differ from provider invoices.

## If a provider fails

- Confirm the selected model is available to your account and its quota has not been exhausted.
- For subscription providers, sign in again if the provider reports expired or revoked access.
- For a local server, confirm it is running and reachable from the daemon computer.
- Check the fallback choice when a provider is down or rate limited. It needs its own valid credentials.
- Check tool-specific errors in Connectors when the model itself still replies.

## Remove access

Clear a provider key, or sign out of a subscription provider, in settings to stop new requests through that provider, including requests from open sections. Bots configured for it will need another model before they can reply.
