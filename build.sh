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
# 顺序说明:根 package.json 的 preinstall 会先跑 scripts/fetch_ui.sh -- 从库
# 仓库的滚动 release(`ui-latest` 上的 miko_ui_dist.tar.gz)取**产物**,校验后
# 解开到 .cache/miko_ui/current,然后把 `"@miko/ui": "file:.cache/miko_ui/current"`
# 这条链接装上.npm 解析 file: 依赖时那个目录必须已经存在,所以"取产物"只能挂在
# preinstall,不能挪到这里之后;CI 也不需要 checkout submodule,不需要任何 npm
# 凭据 -- 公开 release 资产,能访问 GitHub(actions/checkout 本来就要)就够了.
#
# 再往下 build:all 的顺序是 lint:rs -> clean -> build:wasm -> test -> build:app;
# 其中 clean 只删根 dist/ 与 src/generated/,不碰 .cache/miko_ui,所以"产物在第一
# 步就绪,后面全程可用".取产物/链接/模块去重的全部规则见
# scripts/fetch_ui.sh 顶部与 vite.config.ts 的 resolve.dedupe.
npm ci --no-audit --no-fund

# 流水线 = lint:rs -> clean -> build:wasm -> test -> build:app(内含 typecheck + vite build)
log "running full build pipeline (lint -> clean -> wasm -> test -> app)"
npm run build:all

log "build succeeded"
log "output directory: ${PROJECT_ROOT}/dist"
