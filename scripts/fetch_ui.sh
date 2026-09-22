#!/usr/bin/env bash
# 取 `miko_ui` 并本地构建 -- 本仓库拿 `@miko/ui` 的唯一入口.
#
# 为什么不是 npm:
#   库不再发布到 registry,也不再用 GitHub 归档 tarball.来源只有一个:
#   GitHub 上的库仓库,跟随 `main` 分支(库目前完全为本项目服务,还没正式
#   立项,所以不打 tag,不写版本号).
#
# 谁调用它:
#   - 根 `package.json` 的 `preinstall`:所以 `npm ci` / `npm install` 会自动
#     补齐 `packages/miko_ui`(npm 解析 `"@miko/ui": "file:packages/miko_ui"`
#     之前必须已经有这个目录);
#   - `bash ./build.sh` 里的 `npm ci`,因此 CI 也自动经过这里;
#   - 手动:`npm run ui:fetch`(复用现有副本)/ `npm run ui:update`(拉上游).
#
# 行为:
#   1. `packages/miko_ui` 不存在 -> `git clone` 出 `main`(库很小:全量历史
#      不到 1 MB,所以不做浅克隆 -- 浅克隆会让后面的 `merge --ff-only` 判不准
#      祖先关系);
#   2. 已存在 -> 默认**原样复用**(那是本地开发副本,可能带着未推送的提交),
#      只有 `--update` 才会 fetch + 快进;工作区脏或历史分叉时拒绝更新并告警,
#      绝不 `reset --hard`,免得吃掉本地提交;
#   3. 在库目录里 `npm ci` + `npm run build`,产出 `dist/`(产物是应用侧
#      `import '@miko/ui'` 真正解析到的东西);
#   4. 产物已是最新(源码/配置都不比 `dist/index.js` 新,且依赖已装)时直接跳过,
#      所以 preinstall 反复跑不会每次都重新编译.
#
# 用法:bash scripts/fetch_ui.sh [--update] [--rebuild]
#   --update   存在本地副本时也 fetch + 快进到 origin/<ref>
#   --rebuild  忽略"产物已是最新"的短路,强制重新安装与构建
#
# 可覆盖的环境变量:
#   MIKO_UI_REPO    仓库 URL(默认 https://github.com/ToyosatomiminoMiko/miko_ui.git)
#   MIKO_UI_REF     跟随的 ref(默认 main;clone 时必须是分支或 tag,不能是裸 SHA)
#   MIKO_UI_DIR     落地目录(默认 <仓库根>/packages/miko_ui)
#   MIKO_UI_UPDATE=1   等同 --update
#
# 退出码:0 = 库可用;非 0 = 明确失败(缺工具/克隆失败/构建失败),由调用方
# 连带失败,绝不"静默用旧产物继续".

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

REPO_URL="${MIKO_UI_REPO:-https://github.com/ToyosatomiminoMiko/miko_ui.git}"
REF="${MIKO_UI_REF:-main}"
UI_DIR="${MIKO_UI_DIR:-${ROOT}/packages/miko_ui}"

UPDATE=0
REBUILD=0

for arg in "$@"; do
    case "$arg" in
        --update)
            UPDATE=1
            ;;
        --rebuild)
            REBUILD=1
            ;;
        -h | --help)
            # 打印文件头那段说明:跳过 shebang,遇到第一个空行(注释块结束)停止.
            awk 'NR==1 { next } /^[[:space:]]*$/ { exit } { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
            exit 0
            ;;
        *)
            printf '[UI][ERROR] 未知参数: %s(可用: --update / --rebuild / --help)\n' "$arg" >&2
            exit 2
            ;;
    esac
done

if [ "${MIKO_UI_UPDATE:-0}" = "1" ]; then
    UPDATE=1
fi

log() { printf '[UI][%s] %s\n' "$(date '+%Y.%m.%d %H:%M:%S')" "$*"; }
warn() { printf '[UI][WARN][%s] %s\n' "$(date '+%Y.%m.%d %H:%M:%S')" "$*" >&2; }
err() { printf '[UI][ERROR][%s] %s\n' "$(date '+%Y.%m.%d %H:%M:%S')" "$*" >&2; }

require_command() {
    local name="$1"
    if ! command -v "$name" >/dev/null 2>&1; then
        err "缺少必需命令: ${name}"
        exit 127
    fi
}

require_command git
require_command npm
require_command node

# 一个目录要能被当成本库用:package.json 的 name 必须是 miko_ui.
# 防的是"packages/miko_ui 是别的东西"这种静默错配.
assert_is_ui_checkout() {
    local pkg="${UI_DIR}/package.json"
    if [ ! -f "$pkg" ]; then
        err "${UI_DIR} 存在,但没有 package.json;请手工清理后重跑"
        exit 1
    fi
    local name
    name="$(node -p "require('${pkg}').name" 2>/dev/null || true)"
    if [ "$name" != "miko_ui" ]; then
        err "${pkg} 的 name 是 '${name}',不是 'miko_ui';拒绝在该目录上构建"
        exit 1
    fi
}

NEED_CLONE=0
IS_GIT=0

if [ ! -e "$UI_DIR" ]; then
    NEED_CLONE=1
elif [ ! -d "$UI_DIR/.git" ]; then
    if [ -z "$(ls -A "$UI_DIR" 2>/dev/null)" ]; then
        # 上一次 clone 中断会留下一个空目录.不处理的话,之后每次都会走到
        # "不是 git 工作副本"那条告警,再被 assert_is_ui_checkout 判死.
        warn "${UI_DIR} 是空目录(上次 clone 可能中断),删掉重来"
        rmdir "$UI_DIR"
        NEED_CLONE=1
    else
        warn "${UI_DIR} 已存在但不是 git 工作副本;跳过更新,直接构建其中的内容"
    fi
else
    IS_GIT=1
fi

if [ "$NEED_CLONE" = "1" ]; then
    log "克隆 ${REPO_URL} (${REF}) -> ${UI_DIR}"
    mkdir -p "$(dirname "$UI_DIR")"
    git clone --branch "$REF" "$REPO_URL" "$UI_DIR"
elif [ "$IS_GIT" = "1" ] && [ "$UPDATE" = "1" ]; then
    if [ -n "$(git -C "$UI_DIR" status --porcelain)" ]; then
        warn "工作区有未提交改动,跳过更新(仍按当前内容构建)"
    elif git -C "$UI_DIR" fetch origin "$REF"; then
        if git -C "$UI_DIR" merge --ff-only FETCH_HEAD; then
            log "已快进到 origin/${REF}"
        else
            warn "本地 ${REF} 与 origin/${REF} 分叉或有未推送提交,跳过更新(仍按当前内容构建)"
        fi
    else
        warn "git fetch 失败(网络/代理?),跳过更新(仍按当前内容构建)"
    fi
elif [ "$IS_GIT" = "1" ]; then
    log "复用已有工作副本(要拉上游最新:bash scripts/fetch_ui.sh --update)"
fi

assert_is_ui_checkout

# 产物是否已是最新:源码/构建配置/依赖都不比 dist/index.js 新,且依赖装好了.
# 命中就跳过安装与编译,让 preinstall 的重复调用变得便宜.
is_up_to_date() {
    if [ "$REBUILD" = "1" ]; then
        return 1
    fi
    if [ ! -f "$UI_DIR/dist/index.js" ] || [ ! -f "$UI_DIR/dist/index.d.ts" ]; then
        return 1
    fi
    if [ ! -d "$UI_DIR/node_modules" ]; then
        return 1
    fi
    local newer
    newer="$(find "$UI_DIR/src" "$UI_DIR/styles" "$UI_DIR/scripts" \
        "$UI_DIR/package.json" "$UI_DIR/tsconfig.json" "$UI_DIR/tsconfig.build.json" \
        -newer "$UI_DIR/dist/index.js" -print -quit 2>/dev/null)"
    if [ -n "$newer" ]; then
        return 1
    fi
    return 0
}

if is_up_to_date; then
    log "dist/ 已是最新,跳过安装与构建(--rebuild 可强制重建)"
else
    log "安装库依赖并构建"
    if [ -f "$UI_DIR/package-lock.json" ]; then
        (cd "$UI_DIR" && npm ci --no-audit --no-fund)
    else
        (cd "$UI_DIR" && npm install --no-audit --no-fund)
    fi
    (cd "$UI_DIR" && npm run build)
fi

if [ ! -f "$UI_DIR/dist/index.js" ] || [ ! -f "$UI_DIR/dist/index.d.ts" ]; then
    err "构建结束但 dist/index.js 或 dist/index.d.ts 不存在;检查库的构建脚本"
    exit 1
fi

if [ -d "$UI_DIR/.git" ]; then
    log "库版本: $(git -C "$UI_DIR" rev-parse --short HEAD) $(git -C "$UI_DIR" log -1 --format=%s)"
else
    log "库版本: (非 git 工作副本,无法报告 commit)"
fi
log "就绪: ${UI_DIR}/dist"
