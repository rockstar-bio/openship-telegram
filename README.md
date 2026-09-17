# OpenShip Telegram Controller

Small, generic Telegram controller for self-hosted [OpenShip](https://openship.io). It uses only the Telegram Bot API and OpenShip's REST API; it never executes shell commands and contains no provider-, domain-, project-, or server-specific values.

## Features

- `/status` reads OpenShip health and version information.
- `/projects` lists projects and their services.
- `/deploy` and `/redeploy` present inline project buttons.
- Deployment status is polled and success/failure notifications are sent automatically.
- `/deployments` lists recent deployment states.
- Service restart is exposed with per-service inline buttons from `/projects`.
- Access is restricted by configured Telegram user IDs and/or chat IDs.

## Setup

1. Create a Telegram bot with BotFather and copy its token.
2. Create an OpenShip personal access token with the least permissions needed (`project:list`, `project:read`, `deployment:list`, `deployment:read`, and `deployment:write` for deploys).
3. Copy `.env.example` to `.env`, set `OPENSHIP_URL`, `OPENSHIP_API_KEY`, `TELEGRAM_BOT_TOKEN`, and at least one allowed ID.
4. Run locally with Bun:

```sh
bun install
bun run start
```

Or run with Docker Compose:

```sh
docker compose up -d --build
```

Telegram user IDs and chat IDs are numeric and comma-separated. A request is accepted when either its user ID or chat ID is allowed. Keep `.env` private.

## Development

```sh
bun run lint
bun run typecheck
bun test
```

The OpenShip integration is isolated in `src/openship.ts`; new actions should be added there first, then exposed through a narrowly-scoped Telegram handler. Long polling is used so no public webhook endpoint is required.
