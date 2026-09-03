# Docker

Build and start Hexbot from the repository root:

```sh
npm run docker:stage
docker compose -f docker/hexbot/docker-compose.yml up --build -d
```

Hexbot listens on port 9119 and stores its state in the `hexbot-data` volume. Pair a client from inside the running container:

```sh
docker compose -f docker/hexbot/docker-compose.yml exec hexbot hexbot pair
```

The pairing command prints a short code and a link. Open the desktop app, choose an existing daemon, and enter the container host's address with that code.

To rebuild the image without starting it, run `npm run docker:build`.
