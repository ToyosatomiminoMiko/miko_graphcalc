#!/usr/bin/env bash
# Production build entrypoint.
# 这里只负责"安装锁定依赖"和"调用统一流水线",真正的构建/检查步骤序列
# 定义在 package.json 的 build:all 脚本(单一事实源,避免两处重复).
#
# 为什么要保留这个壳而非直接内联到 CI:
#   - 提供可复现的本地入口(bash ./build.sh 与 CI 完全一致);
#   - 覆盖 npm run 无法提供的缺工具快速失败(require_command)
#     与失败时的行号上下文(trap ... ERR),以及分阶段日志前缀.

set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

log() {
    printf '[BUILD][%s] %s\n' "$(date '+%Y.%m.%d.%H:%M:%S')" "$*"
}

err() {
    printf '[BUILD][ERROR][%s] %s\n' "$(date '+%Y.%m.%d.%H:%M:%S')" "$*" >&2
}

require_command() {
    local name="$1"
    if ! command -v "$name" >/dev/null 2>&1; then
        err "missing required command: ${name}"
        exit 127
    fi
}

trap 'err "build failed at line ${LINENO}"' ERR

require_command node
require_command npm
require_command cargo
require_command wasm-pack

log "installing pinned dependencies from package-lock.json"
npm ci --no-audit --no-fund

# 流水线 = lint:rs -> clean -> build:wasm -> test -> build:app(内含 typecheck + vite build)
log "running full build pipeline (lint -> clean -> wasm -> test -> app)"
npm run build:all

log "build succeeded"
log "output directory: ${PROJECT_ROOT}/dist"
