#!/usr/bin/env bash
# Production build entrypoint.
# 这里负责"安装锁定依赖""把 miko_ui 对齐到 npm 最新版"和"调用统一流水线",
# 真正的构建/检查步骤序列定义在 package.json 的 build:all 脚本(单一事实源,
# 避免两处重复).
#
# 为什么要保留这个壳而非直接内联到 CI:
#   - 提供本地入口(bash ./build.sh 与 CI 走同一条;想严格按 lock 构建就设
#     MIKO_UI_SYNC=off);
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

# ---------------------------------------------------------------------------
# miko_ui 版本同步
#
# 库在 npm 上独立发版,`package-lock.json` 不会自己跟着走.这一步在锁定依赖装好
# 之后,把 `miko_ui` 对齐到 npm 的 `latest`:
#
#   MIKO_UI_SYNC=auto  (默认) 落后就 `npm install miko_ui@latest`,并更新
#                             `package.json` / `package-lock.json`
#                             (本地跑完记得提交这两个文件);
#   MIKO_UI_SYNC=check        落后就失败,不改任何文件(只想校验时用);
#   MIKO_UI_SYNC=off          完全按 lock 构建,跳过这一步.
#
# 查不到 latest(断网 / npm 不可用)时:本机警告并沿用 lock;CI(`CI=true`,或显式
# `MIKO_UI_REQUIRE_LATEST=1`)明确失败 -- 部署出去的必须是能说清哪一版的产物.
# 想跳过网络查询(测试这个函数)可以预设 `MIKO_UI_LATEST_VERSION`.
# ---------------------------------------------------------------------------
MIKO_UI_PKG="miko_ui"
MIKO_UI_SYNC="${MIKO_UI_SYNC:-auto}"

sync_miko_ui() {
    if [ "$MIKO_UI_SYNC" = "off" ]; then
        log "miko_ui sync skipped (MIKO_UI_SYNC=off)"
        return 0
    fi
    if [ "$MIKO_UI_SYNC" != "auto" ] && [ "$MIKO_UI_SYNC" != "check" ]; then
        err "invalid MIKO_UI_SYNC='${MIKO_UI_SYNC}' (expected auto|check|off)"
        return 1
    fi

    local locked latest
    locked="$(node -p "require('./node_modules/${MIKO_UI_PKG}/package.json').version" 2>/dev/null || true)"

    latest="${MIKO_UI_LATEST_VERSION:-}"
    if [ -z "$latest" ]; then
        latest="$(npm view "${MIKO_UI_PKG}@latest" version 2>/dev/null | head -n 1 | tr -d '[:space:]')"
    fi

    if [ -z "$latest" ]; then
        if [ -n "${CI:-}" ] || [ "${MIKO_UI_REQUIRE_LATEST:-0}" = "1" ]; then
            err "cannot resolve the latest ${MIKO_UI_PKG} from npm, and this build must not ship a stale version"
            return 1
        fi
        log "WARN: cannot resolve the latest ${MIKO_UI_PKG} from npm; continuing with locked ${locked:-unknown}"
        return 0
    fi

    if [ "$locked" = "$latest" ]; then
        log "miko_ui is already the latest (${latest})"
        return 0
    fi

    if [ "$MIKO_UI_SYNC" = "check" ]; then
        err "${MIKO_UI_PKG} is ${locked:-unknown} but npm latest is ${latest}; run 'npm install ${MIKO_UI_PKG}@latest'"
        return 1
    fi

    log "updating ${MIKO_UI_PKG}: ${locked:-unknown} -> ${latest}"
    npm install "${MIKO_UI_PKG}@${latest}" --no-audit --no-fund
    log "miko_ui is now $(node -p "require('./node_modules/${MIKO_UI_PKG}/package.json').version") (package.json / package-lock.json changed; commit them when building locally)"
}

log "installing pinned dependencies from package-lock.json"
# 依赖全部来自 npm registry:`miko_ui` 是上游库
# (https://github.com/ToyosatomiminoMiko/miko_ui)发布到 npm 的包
#
# 再往下 build:all 的顺序是 lint:rs -> clean -> build:wasm -> test -> build:app;
# 其中 clean 只删根 dist/ 与 src/generated/,不碰 node_modules.
# 生产构建里唯一一份 miko_ui / @preact/signals-core 的实例约束见
# vite.config.ts 的 resolve.dedupe.
npm ci --no-audit --no-fund

# 装完锁定依赖后再对齐 miko_ui:增量装一个包,不必推倒 node_modules 重来.
sync_miko_ui

# 流水线 = lint:rs -> clean -> build:wasm -> test -> build:app
# (后者内含 typecheck + vite build)
log "running full build pipeline (lint -> clean -> wasm -> test -> app)"
npm run build:all

log "build succeeded"
log "output directory: ${PROJECT_ROOT}/dist"
