---
layout: ../../layouts/Docs.astro
title: Docker
description: Build and run a Hexbot daemon with Docker Compose.
---

# Docker

From the repository root, stage the build context and start Hexbot:

```sh
npm run docker:stage
docker compose -f docker/hexbot/docker-compose.yml up --build -d
```

The daemon listens on port `9119`. Docker keeps its state in the `hexbot-data` volume, so replacing the container does not discard your bots and conversations. Back up that volume before moving or removing the deployment.

## Pair a desktop app

Create a pairing code inside the running container:

```sh
docker compose -f docker/hexbot/docker-compose.yml exec hexbot hexbot pair
```

The command prints a short code and pairing link. In the desktop app, choose an existing daemon and enter the Docker host's reachable address with that code. Do not use the container's loopback address from another computer.

## Build without starting

To stage the context and build the `hexbot:local` image without starting Compose, run:

```sh
npm run docker:build
```
