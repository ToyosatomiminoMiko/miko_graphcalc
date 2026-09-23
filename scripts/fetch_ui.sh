#!/usr/bin/env bash
# 取 `miko_ui` 的 **release 产物** -- 本仓库拿 `@miko/ui` 的唯一入口.
#
# ============================================================================
# 应用侧的依赖契约(这段注释是真身,别处只放指针)
# ----------------------------------------------------------------------------
# 1. `@miko/ui` 的**唯一来源**是库仓库的滚动 release 资产:
#
#        https://github.com/<owner>/<repo>/releases/download/ui-latest/miko_ui_dist.tar.gz
#
#    由库的 `.github/workflows/release.yml` 在 main 每次推送后构建并挂上(tag
#    `ui-latest` 是一个滚动 tag,不是版本承诺 -- 库不写版本号,理由见库仓库
#    `RELEASING.md`).本脚本只做四件事:`curl` 下来 -> 校验 -> 解开 -> 原子替换缓存.
#
#    **没有"克隆源码自己构建"这条回退**.这是刻意的:回退会把"资产没挂上 / release
#    配错了 / 网络断了"这类故障掩盖成绿色,而消费者拿到的到底是不是库的产物也再说不清.
#    拿不到就**明确失败**,并把 release 页面,期望 URL 与手动配置步骤打出来(见下面的
#    `print_manual_guide`).要用本机下载好的资产时,`MIKO_UI_ASSET_FILE=<路径>`.
#
#    库这一侧的 release job 还没配好时,这个脚本一定会失败 -- 这是预期行为:
#    先把库的 release.yml 合上并跑出一次资产,再回头跑 `npm ci`.
#
# 2. 落地目录是 `${ROOT}/.cache/miko_ui/current`(gitignore),根 `package.json` 里
#    写 `"@miko/ui": "file:.cache/miko_ui/current"`.这里只有库的**构建产物**
#    (`dist/` + `styles/` + `LICENSE` + 运行期清单),没有库源码.
# 3. **产物是只读的**:本站一行都不改它,也不在应用侧给库的节点补类名 / 改结构去
#    迁就它.**一切以库为准**.确实要改就改库仓库(GitHub 上的 `miko_ui`,或本机的
#    库工作副本 -- 独立仓库,**不在本仓库内**;本机现在在
#    `/mnt/IVSTINIANVS/__projects_web/miko_ui`),重新出一次资产再由这里同步.
# 4. 产物的**运行期依赖由应用侧声明**.根 `package.json` 自己写
#    `@preact/signals-core`(库的运行时依赖)与 `katex`(可选 peer,本仓库引公式):
#    `file:` 链接的传递依赖装不装,取决于目标目录在不在应用根内(npm 实测:根内会
#    装,根外不装).自己声明才不依赖这个细节,也才保证全程只有一份实例;
#    `vite.config.ts` 的 `resolve.dedupe` 是第二道保险.
# 4.1 产物清单(`.cache/miko_ui/current/package.json`)必须是**运行期清单**:资产里那份
#     由库的 release job 生成,不能直接抄库的 package.json -- 抄了会带上
#     `scripts.prepare = npm run build`,而 npm 在装 `file:` 链接的包时会先跑 prepare
#     (npm 10 实测);产物里没有 `scripts/` 与 devDependencies,那一步必炸
#     (`MODULE_NOT_FOUND: scripts/clean.mjs`).本脚本会校验资产清单里**没有** scripts.
# 5. 本脚本在应用流水线里的位置见 `build.sh`:它是 `npm ci` 的 `preinstall`,所以
#    "产物没就绪"这件事一定发生在 npm 解析 `file:` 依赖之前(失败即整体失败,不会
#    出现"装了半个依赖树");`build:all` 的 `clean` 只删根 `dist/` 与
#    `src/generated/`,**不碰**这份缓存.
# 6. 库侧的交付不变量(不发 npm / 不写版本号 / `prepare` 必须留 / 锁只能用完整
#    `npm install` 重建)写在库仓库 `.github/workflows/ci.yml` 与 `RELEASING.md`,
#    发布本身在 `.github/workflows/release.yml`.
# ============================================================================
#
# 谁调用它:
#   - 根 `package.json` 的 `preinstall`:所以 `npm ci` / `npm install` 会自动
#     补齐产物(npm 解析 `"@miko/ui": "file:.cache/miko_ui/current"` 之前必须已经有它);
#   - `bash ./build.sh` 里的 `npm ci`,因此 CI 也自动经过这里;
#   - 手动:`npm run ui:fetch`(已有产物就复用)/ `npm run ui:update`(强制重取).
#
# 行为:
#   1. 已缓存且没要更新 -> 直接用(报出它是从哪来的,对应哪个 commit);
#   2. 否则解析 main 的 commit sha(只用于日志),下载资产,校验,原子替换缓存;
#   3. 任何一步失败 -> 打印 release 页面 / 期望 URL / 手动下载与放置步骤,退出非 0.
#
# 用法:bash scripts/fetch_ui.sh [--update]
#   --update   重新下载一份(默认:缓存看起来健康就直接用)
#
# 可覆盖的环境变量:
#   MIKO_UI_REPO        仓库 URL(默认 https://github.com/ToyosatomiminoMiko/miko_ui.git)
#   MIKO_UI_REF         跟随的 ref(默认 main;只用于日志与 sha 解析)
#   MIKO_UI_RELEASE     滚动 release 的 tag(默认 ui-latest)
#   MIKO_UI_ASSET       资产文件名(默认 miko_ui_dist.tar.gz)
#   MIKO_UI_ASSET_URL   直接给定资产 URL(默认按 repo/tag/资产名拼;镜像 / 代理时用)
#   MIKO_UI_ASSET_FILE  用本机已下载好的资产文件,跳过下载(手动配置时用)
#   MIKO_UI_DIR         产物落地目录(默认 <仓库根>/.cache/miko_ui/current)
#   MIKO_UI_UPDATE=1    等同 --update
#
# 退出码:0 = 产物可用;非 0 = 明确失败(缺工具 / 下载失败 / 校验失败).

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

REPO_URL="${MIKO_UI_REPO:-https://github.com/ToyosatomiminoMiko/miko_ui.git}"
REF="${MIKO_UI_REF:-main}"
RELEASE_TAG="${MIKO_UI_RELEASE:-ui-latest}"
ASSET_NAME="${MIKO_UI_ASSET:-miko_ui_dist.tar.gz}"
UI_DIR="${MIKO_UI_DIR:-${ROOT}/.cache/miko_ui/current}"

# 从仓库 URL 拆出 owner/repo:release 页面,资产 URL,API 地址都要用.
# 支持 https://github.com/O/R.git 与 git@github.com:O/R.git 两种写法.
REPO_SLUG="$(printf '%s' "$REPO_URL" \
    | sed -E 's#^git@[^:]+:##; s#^https?://[^/]+/##; s#\.git$##; s#/+$##')"
RELEASE_PAGE_URL="https://github.com/${REPO_SLUG}/releases"
ASSET_URL="${MIKO_UI_ASSET_URL:-https://github.com/${REPO_SLUG}/releases/download/${RELEASE_TAG}/${ASSET_NAME}}"
API_URL="https://api.github.com/repos/${REPO_SLUG}"

UPDATE=0

for arg in "$@"; do
    case "$arg" in
        --update)
            UPDATE=1
            ;;
        -h | --help)
            # 打印文件头那段说明:跳过 shebang,遇到第一个空行(注释块结束)停止.
            awk 'NR==1 { next } /^[[:space:]]*$/ { exit } { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
            exit 0
            ;;
        *)
            printf '[UI][ERROR] 未知参数: %s(可用: --update / --help)\n' "$arg" >&2
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

require_command curl
require_command tar
require_command node

# ---------- 失败时的手动配置指引 ----------
# 这条不是客套话:资产拿不到时,人需要的是"去哪下,下完放哪,然后怎么让它生效",
# 而不是一句 "download failed".所以把四步一次打全.
print_manual_guide() {
    local reason="$1"
    cat >&2 <<GUIDE

================================================================================
 拿不到 miko_ui 的 release 产物:${reason}
================================================================================

期望的资产地址(就是本脚本要下的那一个):
    ${ASSET_URL}

手动配置步骤:

  1. 打开 release 页面确认资产在不在,名字对不对:
         ${RELEASE_PAGE_URL}
     若**没有** \`${RELEASE_TAG}\` 这个 release 或它下面没有 \`${ASSET_NAME}\`:
     库仓库的 \`.github/workflows/release.yml\` 还没配好 / 还没跑成功,先去把它合上并
     触发一次(main 推送或 workflow_dispatch),产出一个资产再说.

  2. 手动下载资产(浏览器或 curl 都行):
         curl -fL -o ${ASSET_NAME} \\
             "${ASSET_URL}"

  3. 用它生成产物(跳过下载;脚本会照常校验并解到缓存目录):
         MIKO_UI_ASSET_FILE=\$PWD/${ASSET_NAME} bash scripts/fetch_ui.sh --update

     也可以自己解开(等价于脚本做的事):
         rm -rf ${UI_DIR} && mkdir -p ${UI_DIR}
         tar -xzf ${ASSET_NAME} -C ${UI_DIR}
     解开后 ${UI_DIR} 里应当直接是 \`dist/\` \`styles/\` \`package.json\`
     (包根,不要再套一层目录).

  4. 之后正常跑:
         npm ci          # preinstall 会复用缓存里的产物
         npm run build:app

注意:本脚本**没有**"克隆库源码自己构建"的回退路径(那样会把"资产没挂上"这类故障
掩盖成绿色).要靠本地源码构建来排查库的问题时,去库的工作副本(独立仓库,**不在
本仓库内**;本机:\`/mnt/IVSTINIANVS/__projects_web/miko_ui\`,或 GitHub 上的
miko_ui)里 \`npm run build:dist\` -- 那是库自己的事,不经过本仓库.
GUIDE
}

# ---------- 产物校验 ----------
# 守三种静默错配:解开了空/半截 tarball,资产打的是源码而不是产物,资产清单里带着
# `scripts`(npm 装 `file:` 依赖时会去跑库的 prepare,产物里没有 scripts/ 必炸).
#
# 返回 0 = 健康;非 0 = 不健康(原因写进 ARTIFACT_PROBLEM).
ARTIFACT_PROBLEM=''
check_artifact() {
    local dir="$1"
    ARTIFACT_PROBLEM=''
    if [ ! -f "${dir}/package.json" ]; then
        ARTIFACT_PROBLEM='包根没有 package.json(解开时多套/少套了一层目录?)'
        return 1
    fi
    if [ ! -f "${dir}/dist/index.js" ] || [ ! -f "${dir}/dist/index.d.ts" ]; then
        ARTIFACT_PROBLEM='包根缺 dist/index.js 或 dist/index.d.ts(资产不是构建产物?)'
        return 1
    fi
    if node -e 'process.exit(require(process.argv[1]).scripts ? 1 : 0)' "${dir}/package.json" 2>/dev/null; then
        :
    else
        ARTIFACT_PROBLEM="产物清单里有 scripts 字段;npm 装 file: 依赖时会先跑 prepare,必炸.资产清单应由库的 release job 生成(只保留运行期字段)"
        return 1
    fi
    return 0
}

# 产物目录是从哪来的:下载下来的资产会留一张纸条,手动放置的没有.
source_marker() {
    local dir="$1"
    if [ -f "${dir}/.miko-ui-source" ]; then
        cat "${dir}/.miko-ui-source"
    else
        printf '(手动放置 / 来源未知)'
    fi
}

# 原子替换:$UI_DIR 要么是旧的完整产物,要么是新的完整产物,不会出现半截状态.
replace_dir() {
    local from="$1"
    local tmp="${UI_DIR}.tmp.$$"
    rm -rf "$tmp"
    mkdir -p "$(dirname "$UI_DIR")"
    cp -a "$from" "$tmp"
    rm -rf "$UI_DIR"
    mv "$tmp" "$UI_DIR"
}

# ---------- 主流程 ----------

if [ "$UPDATE" != "1" ] && [ -d "$UI_DIR" ] && check_artifact "$UI_DIR"; then
    log "产物已就绪,跳过下载: $(source_marker "$UI_DIR")(要重取: --update)"
    log "目录: ${UI_DIR}"
    exit 0
fi

if [ "$UPDATE" != "1" ] && [ -d "$UI_DIR" ]; then
    warn "缓存里的产物不健康(${ARTIFACT_PROBLEM});重新下载"
fi

# commit sha:只为"这一份是哪一版"留个记号;取不到(离线/限流)不阻塞.
RESOLVED_SHA="$(curl -fsSL --retry 2 --max-time 20 "${API_URL}/commits/${REF}" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).sha??"")}catch{}})' || true)"
if [ -n "$RESOLVED_SHA" ]; then
    log "main 当前 commit: ${RESOLVED_SHA:0:12}"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 1) 取资产:优先用本机已下载的那份,否则下载.
if [ -n "${MIKO_UI_ASSET_FILE:-}" ]; then
    if [ ! -f "$MIKO_UI_ASSET_FILE" ]; then
        err "MIKO_UI_ASSET_FILE 指向的文件不存在: ${MIKO_UI_ASSET_FILE}"
        print_manual_guide 'MIKO_UI_ASSET_FILE 指向的文件不存在'
        exit 1
    fi
    log "使用本机资产: ${MIKO_UI_ASSET_FILE}"
    cp "$MIKO_UI_ASSET_FILE" "${WORK}/${ASSET_NAME}"
else
    log "下载 release 资产: ${ASSET_URL}"
    # 三个 curl 参数各自解决一件事:
    #   --retry-all-errors  资产是**原地覆盖**同一个文件名的(见库的 release.yml),
    #                       覆盖的那一瞬间旧资产已删,新的还没上.此时的 404/5xx 是
    #                       暂时的,不该让消费者 CI 变红;真没有这个 release 时,
    #                       重试完照样明确失败.
    #   --connect-timeout   没有它时,网络不通会按系统默认值挂上百秒,再乘上重试次数
    #                       -- preinstall 变成"卡住好几分钟然后失败",而不是快速说清.
    #   --retry-delay       两次尝试之间留一秒,避开纯粹的瞬间抖动.
    if ! curl -fsSL --retry 3 --retry-delay 1 --retry-all-errors --connect-timeout 20 -o "${WORK}/${ASSET_NAME}" "$ASSET_URL"; then
        err "下载失败: ${ASSET_URL}"
        print_manual_guide '下载失败(没有这个 release / 资产名不对 / 网络不通)'
        exit 1
    fi
fi

# 2) 解开.
mkdir -p "${WORK}/unpack"
if ! tar -xzf "${WORK}/${ASSET_NAME}" -C "${WORK}/unpack"; then
    err "资产不是可用的 tar.gz(传输被截断?)"
    print_manual_guide '资产解不开(不是 tar.gz,或下载不完整)'
    exit 1
fi

# 3) 校验:不是产物就明确失败,绝不把半截东西塞进依赖目录.
if ! check_artifact "${WORK}/unpack"; then
    err "资产校验失败: ${ARTIFACT_PROBLEM}"
    print_manual_guide "资产内容不对: ${ARTIFACT_PROBLEM}"
    exit 1
fi

# 4) 落地.
printf 'release %s @ %s\n' "$RELEASE_TAG" "${RESOLVED_SHA:-(commit 未知)}" > "${WORK}/unpack/.miko-ui-source"
replace_dir "${WORK}/unpack"

log "产物就绪: $(source_marker "$UI_DIR")"
log "目录: ${UI_DIR}"
log "包名: $(node -p "require('${UI_DIR}/package.json').name" 2>/dev/null || echo '?')"
