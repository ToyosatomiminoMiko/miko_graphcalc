#!/usr/bin/env bash
# ============================================================================
# 本地联调 miko_ui: 把 node_modules/miko_ui 换成指向本地工作副本的符号链接.
# ----------------------------------------------------------------------------
# [为什么需要它]
# 应用依赖的是发布在 npm 上的 miko_ui, GitHub Pages 的部署也只能走 npm(见
# README 的"构建"一节与 .github/workflows/deploy.yml). 但改库的时候
# "改一行 -> 发一版 -> 回来更新 lock" 这条环路太长. 这一步只在**本地**把解析
# 目标换成工作副本:
#
#   * 只动 node_modules/(gitignore), 不碰 package.json 与 package-lock.json;
#   * 不动 build.sh / deploy.yml, 所以 gh-pages 与 CI 的行为一个字节都不变;
#   * npm ci(或 bash ./build.sh --ui npm)就能还原成 npm 上那一版.
#
# 之所以这样做而不是把 "file:../..." 写进 package.json: CI 上没有那个路径,
# 仓库里一旦留下本地依赖, Pages 构建会直接失败. 链接只存在于被忽略的
# node_modules/ 里, 没有这个风险.
#
# [用法]
#   bash scripts/dev_ui_link.sh link     # 链接到本地副本(默认动作)
#   bash scripts/dev_ui_link.sh unlink   # 还原成 npm 版(按 lock 重装)
#   bash scripts/dev_ui_link.sh status   # 看当前解析到哪一份
#
# 平时不用直接调它: `bash ./build.sh`(不带参数就是本地副本)会重建副本的 dist/
# 再调这里的 link. 单独用它的场合是"只想链接,不想跑整条流水线", 以及
# status / unlink 这种排查动作.
#
# 工作副本位置默认 ../__projects_web/miko_ui(相对仓库根的上一层), 用
# MIKO_UI_DIR 覆盖:
#   MIKO_UI_DIR=/path/to/miko_ui bash scripts/dev_ui_link.sh link
#
# [链接之后怎么用]
#   * 库的 styles/ 是原样发布的(库的 exports 直接映射到 styles/*.css), 改完
#     **零构建立即生效**;
#   * 库的 src/ 要先编译进 dist/, 两条路:
#         bash ./build.sh                   # 默认: 重建副本 dist/ + 跑完整流水线
#         或 在库里常驻 npx tsc -p tsconfig.build.json --watch
#     (两种别同时用: build:dist 开头会 clean, 和常驻的 watch 会打架);
#   * Vite 会把 root 外已加载的模块加进自己的 watcher, 所以保存后会自动刷新,
#     不需要配 server.fs.allow(见本仓库 vite.config.ts 的 dedupe 说明).
#
# [三个已知坑]
#   1. node_modules/.vite 里可能有上一轮按 npm 包预打包的产物
#      (deps/miko___ui.js), 链接切换前后不清它, 表现是"改了库但页面没动".
#      本脚本在 link / unlink 时都会删掉这个缓存目录.
#   2. 不带参数的 build.sh 默认就走本地副本, 它开头是 npm ci(会把链接冲掉)但随后
#      会重建副本 dist/ 并重新链接; 要回到 npm 上那一版就走
#      bash ./build.sh --ui npm(或 npm ci), 那会把链接换成 npm 版.
#   3. 本地 npm test 也会跟着用工作副本(cssPalette.test.ts /
#      editorStyles.test.ts 直接读库的 styles/), 所以"本地绿"不等于"CI 绿".
# ============================================================================

set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACTION="${1:-link}"
UI_DIR="${MIKO_UI_DIR:-$(dirname "$PROJECT_ROOT")/__projects_web/miko_ui}"
LINK_PATH="${PROJECT_ROOT}/node_modules/miko_ui"
VITE_CACHE="${PROJECT_ROOT}/node_modules/.vite"
UI_PKG_NAME="miko_ui"

log() {
    printf '[UI-LINK] %s\n' "$*"
}

err() {
    printf '[UI-LINK][ERROR] %s\n' "$*" >&2
}

trap 'err "failed at line ${LINENO}"' ERR

# package.json / package-lock.json 的指纹: 用来证明这整套操作没有改到跟踪文件.
# 失败时不是"修复", 而是把问题喊出来让人看 git diff.
tracked_metadata_hash() {
    cat "${PROJECT_ROOT}/package.json" "${PROJECT_ROOT}/package-lock.json" 2>/dev/null |
        sha256sum | cut -d' ' -f1
}

# 删掉 Vite 的依赖预打包缓存. 链接与还原之后都必须做, 否则页面继续吃旧的
# 预打包产物(库现在是链接进来的, 走的是源码路径, 不预打包).
clear_vite_cache() {
    if [ -d "$VITE_CACHE" ]; then
        rm -rf "$VITE_CACHE"
        log "cleared Vite dep cache: node_modules/.vite"
    fi
}

require_ui_checkout() {
    if [ ! -f "${UI_DIR}/package.json" ]; then
        err "no library checkout at ${UI_DIR} (set MIKO_UI_DIR to point at it)"
        exit 1
    fi
    local name
    name="$(node -p "require('${UI_DIR}/package.json').name" 2>/dev/null || true)"
    if [ "$name" != "$UI_PKG_NAME" ]; then
        err "${UI_DIR} is not the ${UI_PKG_NAME} checkout (package.json name='${name:-?}')"
        exit 1
    fi
    # 应用运行时 import 的是库的 dist/, 没有它连 dev server 都起不来. 与其链上去
    # 再报一个难懂的解析错误, 不如在这里直接说清要先编译.
    if [ ! -f "${UI_DIR}/dist/index.js" ]; then
        err "${UI_DIR}/dist/index.js is missing; build the library first:"
        err "    cd ${UI_DIR} && npx tsc -p tsconfig.build.json --watch"
        exit 1
    fi
}

cmd_link() {
    require_ui_checkout

    if [ ! -d "${PROJECT_ROOT}/node_modules" ]; then
        err "node_modules is missing; run 'npm ci' first"
        exit 1
    fi

    local before after target current=""
    before="$(tracked_metadata_hash)"
    target="$(readlink -f "$UI_DIR")"

    if [ -L "$LINK_PATH" ]; then
        current="$(readlink -f "$LINK_PATH" || true)"
    fi

    if [ "$current" = "$target" ]; then
        log "already linked to ${target}"
    else
        # 删掉的是 npm 装的那一份目录, 不是工作副本; 要还原就走 ui:unlink 或 npm ci.
        if [ -e "$LINK_PATH" ] || [ -L "$LINK_PATH" ]; then
            log "replacing npm copy with a link to ${target}"
        else
            log "linking node_modules/${UI_PKG_NAME} -> ${target}"
        fi
        rm -rf "$LINK_PATH"
        ln -s "$target" "$LINK_PATH"
    fi

    clear_vite_cache

    after="$(tracked_metadata_hash)"
    if [ "$before" != "$after" ]; then
        err "package.json / package-lock.json changed unexpectedly; check 'git diff' before committing"
        exit 1
    fi

    log "linked: node_modules/${UI_PKG_NAME} -> ${target} (version $(node -p "require('${LINK_PATH}/package.json').version"))"
    log "the app now resolves the local copy: run 'npx vite' for the local server"
    log "after editing the library's src/, rebuild its dist/ with:"
    log "    bash ./build.sh   (or: cd ${target} && npx tsc -p tsconfig.build.json --watch)"
    log "restore the published package with: bash scripts/dev_ui_link.sh unlink (or npm ci)"
}

cmd_unlink() {
    if [ -L "$LINK_PATH" ]; then
        rm "$LINK_PATH"
        log "removed the link at node_modules/${UI_PKG_NAME}"
    elif [ -e "$LINK_PATH" ]; then
        log "node_modules/${UI_PKG_NAME} is not a link; nothing to unlink"
        return 0
    fi

    local before after
    before="$(tracked_metadata_hash)"
    log "reinstalling ${UI_PKG_NAME} from package-lock.json"
    npm install --no-audit --no-fund
    after="$(tracked_metadata_hash)"
    if [ "$before" != "$after" ]; then
        err "npm install changed package.json / package-lock.json; check 'git diff' before committing"
        exit 1
    fi

    clear_vite_cache
    log "${UI_PKG_NAME} is back to the published version: $(node -p "require('${LINK_PATH}/package.json').version" 2>/dev/null || echo unknown)"
}

cmd_status() {
    if [ -L "$LINK_PATH" ]; then
        log "resolves to the local checkout: $(readlink -f "$LINK_PATH")"
    elif [ -e "$LINK_PATH" ]; then
        log "resolves to the npm package: version $(node -p "require('${LINK_PATH}/package.json').version")"
    else
        log "not installed (run npm ci)"
    fi

    if [ -d "$VITE_CACHE" ]; then
        log "Vite dep cache exists: node_modules/.vite"
    fi

    if command -v git >/dev/null 2>&1 &&
        [ -n "$(git -C "$PROJECT_ROOT" status --porcelain -- package.json package-lock.json 2>/dev/null)" ]; then
        log "WARN: package.json / package-lock.json have uncommitted changes"
    fi
}

case "$ACTION" in
    link) cmd_link ;;
    unlink) cmd_unlink ;;
    status) cmd_status ;;
    *)
        err "unknown action '${ACTION}' (expected link|unlink|status)"
        exit 1
        ;;
esac
