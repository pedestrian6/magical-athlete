#!/bin/sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  runtime="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies"
  if [ -x "$runtime/node/bin/node" ]; then
    PATH="$runtime/node/bin:$runtime/bin/fallback:$PATH"
    export PATH
  else
    echo '未找到 Node.js。请安装 Node.js 24 或更新版本与 pnpm 后重试。' >&2
    exit 1
  fi
fi
if [ "${1:-start}" = start ] && [ ! -d node_modules ]; then
  if ! command -v pnpm >/dev/null 2>&1; then
    echo '未找到 pnpm，请安装 pnpm 11.19.0 后重试。' >&2
    exit 1
  fi
  pnpm install --frozen-lockfile
fi
exec node scripts/dev.mjs "${1:-start}"
