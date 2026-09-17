#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

command -v bun >/dev/null || {
  echo "Bun is required; install it and rerun this script." >&2
  exit 1
}

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install_dir="/opt/openship-telegram-host-runner"
install -d -m 0750 "$install_dir" /etc/openship
install -m 0750 "$repo_dir/src/host-runner.ts" "$install_dir/host-runner.ts"

sed "s|/usr/local/bin/bun|$(command -v bun)|g" \
  "$repo_dir/host-runner/openship-maintenance-runner.service" \
  > /etc/systemd/system/openship-maintenance-runner.service

if [[ ! -e /etc/openship/maintenance-runner.env ]]; then
  umask 077
  cat > /etc/openship/maintenance-runner.env <<'EOF'
MAINTENANCE_RUNNER_BIND_ADDRESS=127.0.0.1
MAINTENANCE_RUNNER_PORT=8787
MAINTENANCE_RUNNER_TOKEN=replace-with-a-long-random-token
PATCH_CACHE_PATH=/root/openship-patches/patch-cache.sh
PATCH_BRANDING_PATH=/root/openship-branding/patch-branding.sh
PATCH_RUN_TIMEOUT_MS=900000
EOF
  echo "Edit /etc/openship/maintenance-runner.env and replace MAINTENANCE_RUNNER_TOKEN." >&2
fi

chmod 0600 /etc/openship/maintenance-runner.env
systemctl daemon-reload
systemctl enable --now openship-maintenance-runner.service
systemctl --no-pager --full status openship-maintenance-runner.service || true

