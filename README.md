# OpenShip Telegram Controller

OpenShip Telegram Controller lets authorized Telegram users monitor and operate a self-hosted [OpenShip](https://openship.io) installation.

## What it can do

- `/status` — clickable host link, health/version, connected-server state, CPU, memory, disk, uptime, and load
- `/projects` — projects, services, and restart buttons
- `/issues` — active outages, unhealthy services, and action-required items
- `/deploy` and `/redeploy` — deploy linked projects
- `/deployments` — recent deployment status and logs
- `/backups` — backup policies and latest run status
- `/updates` — available project updates with confirmed apply buttons
- `/domains` — domain verification and SSL status
- `/jobs` — scheduled jobs and recent run status
- `/clean` — confirmed cleanup of unused deployment images and Docker build-cache
- `/patch` — confirmed cache and branding maintenance patches
- `/menu` — reopen the inline main menu

The bot uses the Telegram Bot API and OpenShip REST API. It does not execute arbitrary shell commands and does not need the Docker socket.

## How `/patch` works

The bot and patch execution are deliberately separated:

1. The Telegram bot checks the user ID, displays buttons, asks for confirmation, and reports progress.
2. A private systemd host-runner on the VPS accepts only the named actions `cache` and `branding`.
3. The host-runner executes the existing root scripts directly.

The bot never mounts `/root`, runs commands, or talks to Docker. `Apply All Patches` always runs Cache first and Branding second; Branding is skipped when Cache fails. Only one patch job can run at a time.

## Requirements

- A VPS running OpenShip
- Docker and Docker Compose
- Bun on the VPS for the systemd host-runner
- These existing executable scripts:
  - `/root/openship-patches/patch-cache.sh`
  - `/root/openship-branding/patch-branding.sh`
- A Telegram bot token from [BotFather](https://t.me/BotFather)
- An OpenShip personal access token
- Your numeric Telegram user ID

## 1. Create credentials

In Telegram, open [@BotFather](https://t.me/BotFather), run `/newbot`, and save the bot token.

Find your numeric Telegram user ID using a trusted Telegram ID tool. Do not use a username; the value must be numeric:

```dotenv
TELEGRAM_ALLOWED_USER_IDS=123456789
```

Create an OpenShip personal access token with the smallest permissions needed:

- `project:list`
- `project:read`
- `deployment:list`
- `deployment:read`
- `deployment:write` for deploy/redeploy
- `job:write` plus instance-admin permission for `/clean` (OpenShip protects built-in garbage-collection jobs)

For `https://vps.rockstar.bio`:

```dotenv
HOST_NAME=My OpenShip Server
OPENSHIP_URL=https://vps.rockstar.bio
OPENSHIP_API_KEY=<your-openship-token>
```

## 2. Install the bot

```sh
git clone <repository-url> openship-telegram
cd openship-telegram
cp .env.example .env
```

Edit `.env`:

```dotenv
OPENSHIP_URL=https://vps.rockstar.bio
OPENSHIP_API_KEY=<your-openship-token>
TELEGRAM_BOT_TOKEN=<your-bot-token>
TELEGRAM_ALLOWED_USER_IDS=<your-numeric-telegram-user-id>
TELEGRAM_ALLOWED_CHAT_IDS=
```

Never commit `.env`; it contains secrets.

## 3. Install the VPS host-runner

Run this from the project directory on the VPS:

```sh
sudo host-runner/install.sh
```

Generate a strong token:

```sh
openssl rand -hex 32
```

Edit the private runner configuration:

```sh
sudoedit /etc/openship/maintenance-runner.env
```

Use the existing VPS scripts:

```dotenv
MAINTENANCE_RUNNER_BIND_ADDRESS=127.0.0.1
MAINTENANCE_RUNNER_PORT=8787
MAINTENANCE_RUNNER_TOKEN=<long-random-token>
PATCH_CACHE_PATH=/root/openship-patches/patch-cache.sh
PATCH_BRANDING_PATH=/root/openship-branding/patch-branding.sh
PATCH_RUN_TIMEOUT_MS=900000
```

Ensure the scripts are executable:

```sh
sudo chmod 700 /root/openship-patches/patch-cache.sh
sudo chmod 700 /root/openship-branding/patch-branding.sh
```

Then start the service:

```sh
sudo chmod 600 /etc/openship/maintenance-runner.env
sudo systemctl restart openship-maintenance-runner
sudo systemctl enable openship-maintenance-runner
sudo systemctl status openship-maintenance-runner --no-pager
```

The runner is a root service because the existing scripts need root privileges. It has no shell endpoint and accepts only these exact pairs:

| Action | Allowed path |
|---|---|
| `cache` | `/root/openship-patches/patch-cache.sh` |
| `branding` | `/root/openship-branding/patch-branding.sh` |

## 4. Connect Docker to the runner

The bot container cannot use the host’s `127.0.0.1`. Find the Docker bridge gateway:

```sh
docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}'
```

It is commonly `172.17.0.1`. Change the runner bind address to that value:

```dotenv
MAINTENANCE_RUNNER_BIND_ADDRESS=172.17.0.1
MAINTENANCE_RUNNER_PORT=8787
MAINTENANCE_RUNNER_TOKEN=<same-long-random-token>
```

Restart the runner:

```sh
sudo systemctl restart openship-maintenance-runner
```

Add these values to the bot’s `.env`:

```dotenv
MAINTENANCE_RUNNER_URL=http://host.docker.internal:8787
MAINTENANCE_RUNNER_TOKEN=<same-long-random-token>
PATCH_CACHE_PATH=/root/openship-patches/patch-cache.sh
PATCH_BRANDING_PATH=/root/openship-branding/patch-branding.sh
PATCH_PROGRESS_INTERVAL_MS=15000
```

The token and paths must match the runner configuration exactly. The Compose file already maps `host.docker.internal` to the Docker host gateway.

Do not expose port `8787` through OpenShip, Nginx, Cloudflare, or public DNS. Keep it restricted to the Docker bridge network in the VPS firewall.

## 5. Start the bot

```sh
docker compose up -d --build
docker compose logs -f openship-telegram
```

The bot uses Telegram long polling, so it does not need a public webhook endpoint.

## 6. Use the Telegram interface

When the bot starts, it registers these commands with Telegram. In the Telegram message box, press `/` to see the command menu:

```text
/start        Open the main menu
/status       Check OpenShip health
/projects     View projects and services
/issues       View active issues
/deploy       Deploy a linked project
/redeploy     Redeploy a project
/deployments  View recent deployments
/backups      View backup status
/updates      View available updates
/domains      View domains and SSL status
/jobs         View scheduled jobs
/clean        Clean unused deployment cache
/patch        Run confirmed maintenance patches
/help         Show command help
```

`/start` and `/menu` open the inline main menu. The buttons provide shortcuts for status, projects, deploy, redeploy, deployments, issues, backups, updates, domains, jobs, patches, and help. Most screens include a `⬅️ Main menu` button so users do not need to type another command.

Operational changes always ask for confirmation. This includes deploy, redeploy, service restart, update apply, backup run, cleanup, and maintenance patches. `/clean` calls only OpenShip 0.7.2's named `images:gc` and `build-cache:gc` jobs. It does not delete arbitrary files, active deployments, or retained rollback artifacts. Logs and issue output are displayed in a bounded message and are HTML-escaped before being sent to Telegram.

Commands also work in group chats using Telegram’s bot-name form, such as `/status@my_openship_bot`.

## 7. Apply a patch from Telegram

1. Open a chat with the bot and send `/start`.
2. Send `/patch`.
3. Choose `Apply Cache Patch`, `Apply Branding Patch`, or `Apply All Patches`.
4. Review the confirmation message.
5. Press `✅ Confirm`.
6. Wait for progress updates and the final result with duration.

Press `Cancel` to stop before execution. Selecting a patch button alone never runs a script.

## Host-runner API

The bot sends:

```http
POST /v1/actions
Authorization: Bearer <MAINTENANCE_RUNNER_TOKEN>
Content-Type: application/json

{"action":"cache","path":"/root/openship-patches/patch-cache.sh"}
```

The runner returns only sanitized status; it never returns script stdout or stderr.

| Status | Meaning |
|---:|---|
| `200` | Patch completed |
| `400` | Action/path is not allowlisted |
| `401` | Token is invalid |
| `409` | Another patch is running |
| `500` | The named script failed |

## Configuration reference

| Variable | Required | Purpose |
|---|---:|---|
| `HOST_NAME` | No | Name shown in Telegram, for example `VPS - Rock Star` |
| `OPENSHIP_URL` | Yes | OpenShip public URL |
| `OPENSHIP_API_KEY` | Yes | OpenShip personal access token |
| `TELEGRAM_BOT_TOKEN` | Yes | BotFather token |
| `TELEGRAM_ALLOWED_USER_IDS` | For `/patch` | Numeric Telegram user IDs |
| `TELEGRAM_ALLOWED_CHAT_IDS` | No | IDs allowed for normal bot commands |
| `MAINTENANCE_RUNNER_URL` | For `/patch` | Usually `http://host.docker.internal:8787` |
| `MAINTENANCE_RUNNER_TOKEN` | For `/patch` | Same token as the systemd runner |
| `PATCH_CACHE_PATH` | No | Cache script path |
| `PATCH_BRANDING_PATH` | No | Branding script path |
| `PATCH_PROGRESS_INTERVAL_MS` | No | Progress interval; default 15 seconds |

## Troubleshooting

### `/patch` says maintenance is not configured

Confirm the bot `.env` contains both runner variables, then recreate the container:

```sh
docker compose up -d --build
```

### The runner is not running

```sh
sudo systemctl status openship-maintenance-runner --no-pager
sudo journalctl -u openship-maintenance-runner -n 100 --no-pager
```

Common causes: missing token, Bun at a different path, or port `8787` already in use.

### The bot cannot connect to the runner

Check that the runner binds to the Docker bridge gateway, not `127.0.0.1`, and that it is listening:

```sh
sudo ss -ltnp | grep 8787
```

Verify that the token and paths match in both `.env` files. Restart both services after changes:

```sh
sudo systemctl restart openship-maintenance-runner
docker compose up -d
```

### The patch returns HTTP 400

The paths differ between bot and runner. Compare them:

```sh
grep -E 'PATCH_(CACHE|BRANDING)_PATH' /etc/openship/maintenance-runner.env
grep -E 'PATCH_(CACHE|BRANDING)_PATH' .env
```

### The patch returns HTTP 500

Run the relevant existing script manually as root and inspect its own logs:

```sh
sudo /root/openship-patches/patch-cache.sh
sudo /root/openship-branding/patch-branding.sh
```

The runner intentionally returns only a sanitized failure message.

## Security rules

- Keep `.env` and `/etc/openship/maintenance-runner.env` private.
- Use a long random runner token.
- Keep port `8787` private; never publish it through a domain.
- Do not add shell commands, user-supplied arguments, or a Docker socket mount.
- Add new maintenance operations only as named actions with fixed paths and fixed behavior.
- Review every script before allowing it to run as root.

## Development

```sh
bun install
bun run lint
bun run typecheck
bun test
```

Host-runner details are also available in [`host-runner/README.md`](host-runner/README.md).
