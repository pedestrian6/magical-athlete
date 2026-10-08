#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/deploy/compose.yaml"
ENV_FILE="$ROOT/deploy/.env"
DATA_PATH="$ROOT/data"
BACKUP_PATH="$ROOT/backups"
LOCK_PATH="$ROOT/logs/.online-ops.lock"

usage() {
  cat <<'HELP'
Usage: scripts/online-ops.sh COMMAND [ARGUMENT]
  status                    Show container, process and application status.
  start                     Start an already-built image; no build or pull.
  stop                      Stop only the game container; retain all data.
  logs                      Show the last 100 log lines, then exit.
  backup [NAME.sqlite]      Make a consistent SQLite backup in backups/.
  restore NAME.sqlite      Verify backup, stop game, save previous DB, restore.
  rollback IMAGE_TAG        Back up DB, switch to an existing local image tag.
  help                      Show this help without accessing Docker.

Run from your own server checkout directory. No remote server is selected.
First copy deploy/.env.example to deploy/.env and build the selected image.
restore starts the game after replacement; it never restores another service.
rollback changes code only. It does not silently overwrite saved games.
HELP
}

compose() {
  if [[ -f "$ENV_FILE" ]]; then
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
  else
    docker compose -f "$COMPOSE_FILE" "$@"
  fi
}

prepare_directories() {
  mkdir -p "$DATA_PATH" "$BACKUP_PATH" "$ROOT/logs"
  chmod 700 "$DATA_PATH" "$BACKUP_PATH"
}

acquire_lock() {
  mkdir -p "$ROOT/logs"
  if ! mkdir "$LOCK_PATH" 2>/dev/null; then
    printf '已有运维操作或遗留锁：%s；核实其中 PID 后再处理。\n' "$LOCK_PATH" >&2
    exit 1
  fi
  printf '%s\n' "$$" > "$LOCK_PATH/pid"
  trap 'rm -f "$LOCK_PATH/pid"; rmdir "$LOCK_PATH"' EXIT
}

selected_image() {
  compose config --images | head -n 1
}

maintenance() {
  local image
  image="$(selected_image)"
  docker image inspect "$image" >/dev/null
  docker run --rm --network none --user 1000:1000 --read-only \
    --cap-drop ALL --security-opt no-new-privileges:true \
    --tmpfs /tmp:rw,noexec,nosuid,size=16m \
    --mount "type=bind,source=$DATA_PATH,target=/app/data" \
    --mount "type=bind,source=$BACKUP_PATH,target=/app/backups" \
    --env DATA_DIR=/app/data --env BACKUP_DIR=/app/backups \
    --env "GAME_STOPPED_FOR_RESTORE=${GAME_STOPPED_FOR_RESTORE:-no}" \
    "$image" node scripts/sqlite-maintenance.mjs "$@"
}

do_backup() {
  local name="${1:-rooms-$(date -u +%Y%m%dT%H%M%SZ)-$$.sqlite}"
  maintenance backup "$name"
  printf '备份：%s/%s\n' "$BACKUP_PATH" "$name"
}

persist_tag() {
  local tag="$1" temporary
  temporary="$(mktemp "$ROOT/deploy/.env.tmp.XXXXXX")"
  if [[ -f "$ENV_FILE" ]]; then
    awk '!/^[[:space:]]*IMAGE_TAG=/' "$ENV_FILE" > "$temporary"
  fi
  printf '\nIMAGE_TAG=%s\n' "$tag" >> "$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$ENV_FILE"
}

command="${1:-help}"
if [[ "$command" == 'help' || "$command" == '--help' || "$command" == '-h' ]]; then
  usage
  exit 0
fi
command -v docker >/dev/null || { printf '需要 Docker 与 Docker Compose 插件。\n' >&2; exit 1; }
docker compose version >/dev/null

case "$command" in
  status)
    compose ps --all
    container="$(compose ps --all --quiet game)"
    if [[ -n "$container" ]]; then
      docker inspect --format 'PID={{.State.Pid}} status={{.State.Status}} exit={{.State.ExitCode}} image={{.Config.Image}} {{if .State.Health}}health={{.State.Health.Status}}{{end}}' "$container"
    fi
    if [[ -f "$DATA_PATH/status.json" ]]; then head -n 100 "$DATA_PATH/status.json"; fi
    ;;
  logs)
    compose logs --no-color --tail 100 game
    ;;
  start)
    acquire_lock
    prepare_directories
    docker network inspect caddy >/dev/null
    docker image inspect "$(selected_image)" >/dev/null
    compose up -d --no-deps --no-build --pull never game
    ;;
  stop)
    acquire_lock
    compose stop game
    ;;
  backup)
    acquire_lock
    prepare_directories
    do_backup "${2:-}"
    ;;
  restore)
    [[ $# -eq 2 ]] || { usage >&2; exit 1; }
    acquire_lock
    prepare_directories
    maintenance verify "$2"
    compose stop game
    if ! GAME_STOPPED_FOR_RESTORE=yes maintenance restore "$2"; then
      printf '恢复失败，游戏保持停止。原库备份在 backups/；请检查后再启动。\n' >&2
      exit 1
    fi
    compose up -d --no-deps --no-build --pull never game
    ;;
  rollback)
    [[ $# -eq 2 && "$2" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || { usage >&2; exit 1; }
    acquire_lock
    prepare_directories
    docker image inspect "magical-athlete-online:$2" >/dev/null
    if [[ -f "$DATA_PATH/rooms.sqlite" ]]; then do_backup; fi
    IMAGE_TAG="$2" compose up -d --no-deps --no-build --pull never game
    persist_tag "$2"
    printf '已切换到 %s；请执行 status 与 HTTPS 健康检查。\n' "$2"
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
