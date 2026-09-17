# OpenShip maintenance host-runner

This service runs directly on the OpenShip VPS. It is the only component that executes the existing root patch scripts for the Telegram bot.

## What it accepts

The service exposes one private endpoint:

```http
POST /v1/actions
Authorization: Bearer <token>
Content-Type: application/json

{"action":"cache","path":"/root/openship-patches/patch-cache.sh"}
```

Only these named actions exist:

| Action | Fixed executable path by default |
|---|---|
| `cache` | `/root/openship-patches/patch-cache.sh` |
| `branding` | `/root/openship-branding/patch-branding.sh` |

The request path must exactly match the configured path. Unknown actions, path substitution, invalid tokens, and concurrent jobs are rejected. Scripts are executed directly with `Bun.spawn([path])`; the service never invokes a shell and never accepts command text or user arguments.

Script output is not returned or logged. Responses contain only sanitized `completed` or `failed` status.

## Install

From the repository root on the VPS:

```sh
sudo host-runner/install.sh
```

Generate a token and keep it private:

```sh
openssl rand -hex 32
```

Edit the generated configuration:

```sh
sudoedit /etc/openship/maintenance-runner.env
```

Example for the existing VPS scripts:

```dotenv
MAINTENANCE_RUNNER_BIND_ADDRESS=172.17.0.1
MAINTENANCE_RUNNER_PORT=8787
MAINTENANCE_RUNNER_TOKEN=<long-random-token>
PATCH_CACHE_PATH=/root/openship-patches/patch-cache.sh
PATCH_BRANDING_PATH=/root/openship-branding/patch-branding.sh
PATCH_RUN_TIMEOUT_MS=900000
```

Use `127.0.0.1` if the caller is on the host itself. Use the Docker bridge gateway when the caller is the bot container:

```sh
docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}'
```

Then enable the service:

```sh
sudo chmod 600 /etc/openship/maintenance-runner.env
sudo systemctl restart openship-maintenance-runner
sudo systemctl enable openship-maintenance-runner
sudo systemctl status openship-maintenance-runner --no-pager
```

Configure the bot with the same token:

```dotenv
MAINTENANCE_RUNNER_URL=http://host.docker.internal:8787
MAINTENANCE_RUNNER_TOKEN=<same-long-random-token>
```

The bot Compose file maps `host.docker.internal` to the Docker host gateway.

## Installed files

- `openship-maintenance-runner.service` — systemd unit template
- `install.sh` — installs and enables the service
- `/opt/openship-telegram-host-runner/host-runner.ts` — installed runner
- `/etc/openship/maintenance-runner.env` — private runtime configuration

The unit runs as root because the existing scripts require root privileges. It uses a restrictive umask and `PrivateTmp=true`. Keep port `8787` private and never route it through OpenShip, Nginx, Cloudflare, or public DNS.

## Monitoring

```sh
sudo systemctl status openship-maintenance-runner --no-pager
sudo journalctl -u openship-maintenance-runner -f
sudo ss -ltnp | grep 8787
```

The runner returns HTTP `200` after success, `500` after a script failure, `401` for a bad token, `400` for an unsupported action/path, and `409` when another job is running.
