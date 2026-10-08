#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/logs"
if [[ ! -f "$ROOT/deploy/.env" ]]; then
  printf '请先从 deploy/.env.example 创建 deploy/.env，并指定新的 IMAGE_TAG。\n' >&2
  exit 1
fi
args=(--env-file "$ROOT/deploy/.env" -f "$ROOT/deploy/compose.yaml")
image="$(docker compose "${args[@]}" config --images | head -n 1)"
if docker image inspect "$image" >/dev/null 2>&1; then
  printf '镜像 %s 已存在。请设置新的 IMAGE_TAG，避免覆盖可回滚版本。\n' "$image" >&2
  exit 1
fi
printf '%s\n' "$$" > "$ROOT/logs/online-build.pid"
rm -f "$ROOT/logs/online-build.exit"
printf '{"status":"building","pid":%s,"updated_at":"%s"}\n' "$$" "$(date -u +%FT%TZ)" > "$ROOT/logs/online-build.status.json"
finish() {
  local result=$?
  trap - EXIT
  printf '%s\n' "$result" > "$ROOT/logs/online-build.exit"
  printf '{"status":"finished","pid":%s,"exitCode":%s,"updated_at":"%s"}\n' "$$" "$result" "$(date -u +%FT%TZ)" > "$ROOT/logs/online-build.status.json"
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
set +e
docker compose "${args[@]}" build game 2>&1 | tee "$ROOT/logs/online-build.log"
result=${PIPESTATUS[0]}
set -e
exit "$result"
