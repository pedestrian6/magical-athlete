#!/usr/bin/env bash
# Run inside the isolated server checkout, normally from a named tmux session.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/logs"
printf '%s\n' "$$" > "$ROOT/logs/online-release.pid"
rm -f "$ROOT/logs/online-release.exit"
stage=preflight
status() {
  printf '{"status":"%s","pid":%s,"updated_at":"%s"}\n' "$stage" "$$" "$(date -u +%FT%TZ)" > "$ROOT/logs/online-release.status.json.tmp"
  mv "$ROOT/logs/online-release.status.json.tmp" "$ROOT/logs/online-release.status.json"
}
finish() {
  local result=$?
  trap - EXIT
  printf '%s\n' "$result" > "$ROOT/logs/online-release.exit"
  printf '{"status":"finished","stage":"%s","pid":%s,"exitCode":%s,"updated_at":"%s"}\n' "$stage" "$$" "$result" "$(date -u +%FT%TZ)" > "$ROOT/logs/online-release.status.json.tmp"
  mv "$ROOT/logs/online-release.status.json.tmp" "$ROOT/logs/online-release.status.json"
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
status
[[ -f "$ROOT/deploy/.env" ]]
[[ -d "$ROOT/data" && -d "$ROOT/backups" ]]
docker network inspect caddy >/dev/null
docker ps --format '{{.Names}} {{.Status}}' > "$ROOT/logs/existing-containers-before.txt"
stage=building; status
bash "$ROOT/scripts/online-build.sh"
stage=starting; status
bash "$ROOT/scripts/online-ops.sh" start
stage=checking_https; status
domain="$(sed -n 's/^GAME_DOMAIN=//p' "$ROOT/deploy/.env")"
[[ "$domain" =~ ^[a-zA-Z0-9.-]+$ ]]
# Bounded certificate provisioning check. Never bypass TLS verification.
curl --noproxy '*' --fail --show-error --silent --connect-timeout 10 --max-time 15 \
  --retry 5 --retry-all-errors --retry-delay 10 --retry-max-time 90 \
  "https://$domain/healthz" > "$ROOT/logs/public-health.json"
stage=backing_up; status
bash "$ROOT/scripts/online-ops.sh" backup "initial-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
bash "$ROOT/scripts/online-ops.sh" status
docker ps --format '{{.Names}} {{.Status}}' > "$ROOT/logs/existing-containers-after.txt"
stage=deployed; status
printf 'Deployment passed HTTPS health check. Browser gameplay verification is a separate step.\n'
