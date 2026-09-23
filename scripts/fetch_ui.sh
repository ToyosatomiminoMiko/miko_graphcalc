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
#    `RELEASING.md`).本脚本做五件事:`curl` 下来 -> 校验 -> 解开 -> 原子替换缓存,
#    外加**复用时先确认手里这份是不是最新发布的**(见 §7).
#
#    **没有"克隆源码自己构建"这条回退**.这是刻意的:回退会把"资产没挂上 / release
#    配错了 / 网络断了"这类故障掩盖成绿色,而消费者拿到的到底是不是库的产物也再说不清.
#    拿不到就**明确失败**,并把 release 页面,期望 URL 与手动配置步骤打出来(见下面的
#    `print_manual_guide`).要用本机下载好的资产时,`MIKO_UI_ASSET_FILE=<路径>`.
#    下载先走 `ASSET_URL`(github.com);那个主机在某些网络里会**间歇性连不上**
#    (DNS 通,TCP 超时),所以失败后还会走一次 GitHub API 的资产端点
#    (api.github.com)取同一份字节 -- 换的只是路径,资产是谁仍由产物校验 + `gitHead`
#    比对说了算.两条都拿不到才失败.
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
#    `npm install` 重建 / 资产必须自证 commit)写在库仓库 `.github/workflows/ci.yml`
#    与 `RELEASING.md`,发布本身在 `.github/workflows/release.yml`.
# 7. **每次构建都确认"手里这份是最新发布的"**.库不写版本号,所以"最新"由两串
#    commit sha 定义:
#
#      - 资产清单里的 `gitHead` = 这一份是哪个 commit 构建的(库打包时写进去的,
#        **权威**;本地工作树脏时是 `<sha>-dirty`);
#      - `ui-latest` tag 指向的 commit = 最新发布的那一份(release.yml 先传资产,
#        再把 tag 强推过去).
#
#    复用时清单里的 `gitHead` 是权威:两串相等 -> 直接用;不等 -> 重新下载(自动,
#    不用 `--update`).查 tag 用 `git ls-remote --tags`:公开仓库免认证,不吃
#    GitHub API 限额;没 git 才退到 REST `/git/ref/tags/<tag>`.资产**没有 gitHead**
#    (旧资产 / 库侧还没带上)时不能确证新鲜,但来源纸条还能给出**落后**的证据:
#    纸条说下到的是 X,tag 已经到 Y,就直接重取(纸条只用来触发重取,不用来宣布
#    "最新").两条都不通,或者没有 gitHead 又没有落后证据,才是"查不到":
#
#      - **CI 里明确失败**(`CI` 非空时必须有确证 -- 部署出去的不能是"说不清哪一版"
#        的缓存,这条是刻意的,不是配置错误);
#      - 本地只警告并沿用缓存(断网也要能构建).
#
#    要无条件跳过检查:`MIKO_UI_SKIP_CHECK=1`;要本地也严格:
#    `MIKO_UI_REQUIRE_LATEST=1`.`MIKO_UI_ASSET_FILE` 手动放进去的资产记成
#    `local-file`,不参与新旧检查(不然下一次 `npm ci` 会把它换成发布产物,而"手动
#    放"本来就是发布坏掉时的兜底,见 `print_manual_guide`).
# ============================================================================
#
# 谁调用它:
#   - 根 `package.json` 的 `preinstall`:所以 `npm ci` / `npm install` 会自动
#     补齐产物(npm 解析 `"@miko/ui": "file:.cache/miko_ui/current"` 之前必须已经有它);
#   - `bash ./build.sh` 里的 `npm ci`,因此 CI 也自动经过这里;
#   - 手动:`npm run ui:fetch`(已有产物就复用)/ `npm run ui:update`(强制重取).
#
# 行为:
#   1. 已缓存且没要更新 -> **先确认它是不是最新发布的**(§7):是最新就直接用(报出
#      它是从哪来的 / 哪个 commit);落后就自动重新下载;查不到则本地警告后沿用,
#      CI 里明确失败;
#   2. 没缓存 / 缓存不健康 / `--update` -> 下载资产,校验,原子替换缓存;
#   3. 任何一步失败 -> 打印 release 页面 / 期望 URL / 手动下载与放置步骤,退出非 0.
#
# 用法:bash scripts/fetch_ui.sh [--update]
#   --update   重新下载一份(默认:缓存健康且是最新就直接用)
#
# 可覆盖的环境变量:
#   MIKO_UI_REPO          仓库 URL(默认 https://github.com/ToyosatomiminoMiko/miko_ui.git)
#   MIKO_UI_RELEASE       滚动 release 的 tag(默认 ui-latest)
#   MIKO_UI_ASSET         资产文件名(默认 miko_ui_dist.tar.gz)
#   MIKO_UI_ASSET_URL     直接给定资产 URL(默认按 repo/tag/资产名拼;镜像 / 代理时用)
#   MIKO_UI_ASSET_FILE    用本机已下载好的资产文件,跳过下载(手动配置时用)
#   MIKO_UI_DIR           产物落地目录(默认 <仓库根>/.cache/miko_ui/current)
#   MIKO_UI_UPDATE=1      等同 --update
#   MIKO_UI_SKIP_CHECK=1  跳过新旧检查,缓存健康就直接用(离线 / 手动放资产时)
#   MIKO_UI_REQUIRE_LATEST=1  查不到新旧也算失败(默认只有 CI 里才这样)
#   GITHUB_TOKEN / GH_TOKEN  查 tag 退到 REST,或下载绕行 API 资产端点时用:有就走
#                         认证,免撞匿名限额(60 次/小时)
#
# 退出码:0 = 产物可用;非 0 = 明确失败(缺工具 / 下载失败 / 校验失败 / 查不到新旧
# 且不许将就).

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

REPO_URL="${MIKO_UI_REPO:-https://github.com/ToyosatomiminoMiko/miko_ui.git}"
RELEASE_TAG="${MIKO_UI_RELEASE:-ui-latest}"
ASSET_NAME="${MIKO_UI_ASSET:-miko_ui_dist.tar.gz}"
UI_DIR="${MIKO_UI_DIR:-${ROOT}/.cache/miko_ui/current}"
# 相对路径一律按仓库根解析:`check_artifact` 与"包名"那几处用 node 读清单,而
# `require()` 只认以 `./` 或 `/` 开头的路径 -- 裸相对路径会被当成模块名,报
# MODULE_NOT_FOUND,于是"缓存健康"被误判成"产物清单里有 scripts".补成绝对路径
# 之后,`MIKO_UI_DIR=.cache/foo` 这种写法也能用.
case "$UI_DIR" in
    /*) ;;
    *) UI_DIR="${ROOT}/${UI_DIR}" ;;
esac

# 从仓库 URL 拆出 owner/repo:release 页面,资产 URL,API 地址都要用.
# 支持 https://github.com/O/R.git 与 git@github.com:O/R.git 两种写法.
REPO_SLUG="$(printf '%s' "$REPO_URL" \
    | sed -E 's#^git@[^:]+:##; s#^https?://[^/]+/##; s#\.git$##; s#/+$##')"
RELEASE_PAGE_URL="https://github.com/${REPO_SLUG}/releases"
ASSET_URL="${MIKO_UI_ASSET_URL:-https://github.com/${REPO_SLUG}/releases/download/${RELEASE_TAG}/${ASSET_NAME}}"
API_URL="https://api.github.com/repos/${REPO_SLUG}"

# 走 API 的两处(查 tag 的退路,下载绕行)在有限额时用 token:CI 里 `github.token`
# 就够,本地没有也能跑(匿名 60 次/小时).数组的展开写成
# `${CURL_AUTH[@]+"${CURL_AUTH[@]}"}`,是为了 macOS 自带的 bash 3.2(set -u 下展开
# 空数组会报错).
CURL_AUTH=()
if [ -n "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ]; then
    CURL_AUTH=(-H "Authorization: Bearer ${GITHUB_TOKEN:-${GH_TOKEN:-}}")
fi

UPDATE=0
SKIP_CHECK="${MIKO_UI_SKIP_CHECK:-0}"
REQUIRE_LATEST="${MIKO_UI_REQUIRE_LATEST:-0}"

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

# ---------- 新旧检查:手里这份是不是最新发布的?(规则见文件头 §7) ----------
# 三个前提:库打包时把构建 commit 写进了清单的 `gitHead`;release.yml 每次都把
# `ui-latest` 强推到那次构建的 commit;查 tag 用 `git ls-remote`(公开仓库免认证,
# 不吃 GitHub API 限额).

# 有 timeout 就用:ls-remote 挂住时不该把 preinstall 拖成几分钟(与 curl 的
# --connect-timeout 同一个理由).
with_timeout() {
    local secs="$1"
    shift
    if command -v timeout >/dev/null 2>&1; then
        timeout "$secs" "$@"
    else
        "$@"
    fi
}

is_sha() { printf '%s' "$1" | grep -Eq '^[0-9a-f]{7,64}$'; }

# 最新发布的那一份 = `ui-latest` tag 指向的 commit.查不到就打印空,让调用处决定
# 是"警告后沿用"还是"CI 里失败".**只用 ref,不用 release 对象**:release 的
# `target_commitish` 只在建 release 时记一次,之后强推 tag 不会更新它.
resolve_tag_sha() {
    if command -v git >/dev/null 2>&1; then
        local out sha
        out="$(with_timeout 25 git ls-remote --tags "$REPO_URL" \
            "refs/tags/${RELEASE_TAG}" "refs/tags/${RELEASE_TAG}^{}" 2>/dev/null || true)"
        # 注解 tag 会多出一行 `<sha> refs/tags/<tag>^{}`(指向它包住的 commit):优先它.
        sha="$(printf '%s\n' "$out" | awk -v t="refs/tags/${RELEASE_TAG}^{}" '$2 == t { print $1; exit }')"
        if ! is_sha "$sha"; then
            sha="$(printf '%s\n' "$out" | awk -v t="refs/tags/${RELEASE_TAG}" '$2 == t { print $1; exit }')"
        fi
        if is_sha "$sha"; then
            printf '%s' "$sha"
            return 0
        fi
    fi
    # 没有 git(或 ls-remote 失败)时的退路:REST ref 接口(api.github.com 与
    # github.com 是两个主机,这个网络里前者通常稳得多).注解 tag 这一路解不出
    # commit(object.type=tag),会返回空 -- 本仓库的滚动 tag 是轻量 tag.
    local json
    json="$(with_timeout 20 curl -fsSL ${CURL_AUTH[@]+"${CURL_AUTH[@]}"} \
        -H 'Accept: application/vnd.github+json' \
        "${API_URL}/git/ref/tags/${RELEASE_TAG}" 2>/dev/null || true)"
    printf '%s' "$json" | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.object?.type==="commit"?(j.object?.sha??""):"")}catch{}})'
}

# 主 URL(github.com)不通时的第二条路:先问 API 要 release 的资产清单,再按
# `Accept: application/octet-stream` 拉同一个资产(它会 302 到
# objects.githubusercontent.com -- 那个主机通常没问题).换的只是**路径**,字节是
# 同一份;它到底对不对,由后面的产物校验与 gitHead 比对负责.只在没显式给
# `MIKO_UI_ASSET_URL` 时才用它:显式覆盖(镜像 / 代理)是人指的路,不该被悄悄换掉.
download_asset_via_api() {
    local out="$1" json id
    json="$(with_timeout 20 curl -fsSL ${CURL_AUTH[@]+"${CURL_AUTH[@]}"} \
        -H 'Accept: application/vnd.github+json' \
        "${API_URL}/releases/tags/${RELEASE_TAG}" 2>/dev/null || true)"
    id="$(printf '%s' "$json" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try {
        const j = JSON.parse(s);
        const a = (j.assets || []).find((x) => x.name === process.argv[1]);
        process.stdout.write(a ? String(a.id) : "");
    } catch {}
});
' "$ASSET_NAME")"
    if [ -z "$id" ]; then
        warn "API 里没找到 release ${RELEASE_TAG} 的资产 ${ASSET_NAME}(release 还没建好?或撞了匿名限额)"
        return 1
    fi
    log "改走 API 资产端点: ${API_URL}/releases/assets/${id}"
    with_timeout 120 curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors \
        --connect-timeout 10 --max-time 45 ${CURL_AUTH[@]+"${CURL_AUTH[@]}"} \
        -H 'Accept: application/octet-stream' -o "$out" \
        "${API_URL}/releases/assets/${id}"
}

# 这份产物**自己声明**的 commit(清单里的 gitHead).空 = 它不自证版本(旧资产,或
# 手动放进去的本地资产),调用处会把这种情况当"查不到".
manifest_revision() {
    node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try {
        const m = JSON.parse(s);
        process.stdout.write(typeof m.gitHead === "string" ? m.gitHead : "");
    } catch {}
});
' <"$1/package.json" 2>/dev/null || true
}

# 手动放进去的资产(纸条写着 local-file)不参与新旧检查:下一次 npm ci 不该把它换成
# 发布产物 -- "手动放"本来就是发布坏掉时的兜底(见 print_manual_guide).
marker_is_local() {
    [ -f "$1/.miko-ui-source" ] && head -1 "$1/.miko-ui-source" | grep -q '^local-file'
}

# 来源纸条里那个 commit(没有就打印空).它只证明"下载时 tag 指哪",不能反过来证明
# "这就是最新",所以只用于给"落后"提供证据,以及日志里报来源.
marker_revision() {
    [ -f "$1/.miko-ui-source" ] && sed -n 's/.*@ \([0-9a-f]\{7,64\}\).*/\1/p' "$1/.miko-ui-source" | head -1
}

# 查不到新旧时的口径:CI 里必须有确证(部署出去的不能是"说不清哪一版"的缓存),
# 本地断网照样要能构建.$2 = 本地怎么办(复用路径是"沿用缓存",下载路径是"照常落地").
check_unavailable() {
    local reason="$1"
    local local_action="${2:-沿用缓存}"
    if [ "$REQUIRE_LATEST" = "1" ] || [ -n "${CI:-}" ]; then
        err "无法确认产物是不是最新发布的:${reason}"
        err "CI 里这算失败(要确证部署的就是最新那一版);本机断网可以 MIKO_UI_SKIP_CHECK=1 跳过检查"
        err "库的 release 页面: ${RELEASE_PAGE_URL}"
        err "若是库侧还没把 gitHead 写进资产:先合上库的 scripts/pack_release.mjs 并推 main,等 release 跑完再重跑这里"
        exit 1
    fi
    warn "无法确认产物是不是最新发布的(${reason});${local_action}.离线时属正常;要消掉这条警告: MIKO_UI_SKIP_CHECK=1"
}

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

     这个主机(github.com)在部分网络里会间歇性连不上(DNS 通,TCP 超时,脚本自己
     会重试并绕行).手动下载时也可以换 API 资产端点 -- 同一份字节:
         ID=\$(curl -fsSL "${API_URL}/releases/tags/${RELEASE_TAG}" \\
             | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const a=(j.assets||[]).find(x=>x.name===process.argv[1]);process.stdout.write(a?String(a.id):"")})' "${ASSET_NAME}")
         curl -fL -H 'Accept: application/octet-stream' -o ${ASSET_NAME} \\
             "${API_URL}/releases/assets/\${ID}"

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

TAG_SHA=''
CACHE_HEALTHY=0
if [ -d "$UI_DIR" ] && check_artifact "$UI_DIR"; then
    CACHE_HEALTHY=1
fi

if [ "$UPDATE" != "1" ] && [ "$CACHE_HEALTHY" = "1" ]; then
    if [ "$SKIP_CHECK" = "1" ]; then
        log "MIKO_UI_SKIP_CHECK=1:不查新旧,缓存健康就直接用: $(source_marker "$UI_DIR")"
        log "目录: ${UI_DIR}"
        exit 0
    fi
    if marker_is_local "$UI_DIR"; then
        log "缓存是手动放置的资产($(source_marker "$UI_DIR")),不查新旧(要换回发布产物: --update)"
        log "目录: ${UI_DIR}"
        exit 0
    fi

    # 手里这份是哪个 commit:清单里的 gitHead 是**权威**;没有它就只能拿来源纸条做
    # "是否落后"的旁证(纸条只证明"下载时 tag 指哪",不能反过来宣布"最新").
    CACHED_REV="$(manifest_revision "$UI_DIR" || true)"
    TAG_SHA="$(resolve_tag_sha || true)"

    if [ -z "$TAG_SHA" ]; then
        check_unavailable "查不到 tag ${RELEASE_TAG} 指向哪个 commit(断网 / 没 git / 仓库或 tag 名不对)"
        log "沿用缓存: $(source_marker "$UI_DIR")"
        log "目录: ${UI_DIR}"
        exit 0
    fi

    if [ -n "$CACHED_REV" ] && [ "$CACHED_REV" = "$TAG_SHA" ]; then
        log "已是最新: ${TAG_SHA:0:12}($(source_marker "$UI_DIR"))"
        log "目录: ${UI_DIR}"
        exit 0
    fi

    if [ -n "$CACHED_REV" ]; then
        log "缓存是 ${CACHED_REV:0:12},而 ${RELEASE_TAG} 已经到 ${TAG_SHA:0:12};重新取一份"
    else
        # 没有 gitHead:不能宣布"最新",但纸条能给出**落后**的证据 -- 纸条说下到的是
        # X,tag 已经到 Y,那就直接重取(这条只用来触发重取,不用来确证新鲜).
        MARKER_REV="$(marker_revision "$UI_DIR" || true)"
        if [ -n "$MARKER_REV" ] && [ "$MARKER_REV" != "$TAG_SHA" ]; then
            log "资产不自证版本(清单没有 gitHead):来源纸条是 ${MARKER_REV:0:12},而 ${RELEASE_TAG} 已经到 ${TAG_SHA:0:12};重新取一份"
        else
            check_unavailable "缓存里的资产清单没有 gitHead(旧缓存,或库侧还没把构建 commit 写进资产)"
            log "沿用缓存: $(source_marker "$UI_DIR")"
            log "目录: ${UI_DIR}"
            exit 0
        fi
    fi
fi

if [ "$UPDATE" != "1" ] && [ -d "$UI_DIR" ] && [ "$CACHE_HEALTHY" != "1" ]; then
    warn "缓存里的产物不健康(${ARTIFACT_PROBLEM});重新下载"
fi

# 走到这里才需要"最新指哪":--update / 没缓存 / 缓存落后时上面那条检查没跑或没定论.
# 查不到不阻塞下载(资产自己带着 gitHead),只影响日志与落地时写纸条.
if [ -z "$TAG_SHA" ]; then
    TAG_SHA="$(resolve_tag_sha || true)"
fi
if [ -n "$TAG_SHA" ]; then
    log "${RELEASE_TAG} 当前指向: ${TAG_SHA:0:12}"
else
    warn "查不到 ${RELEASE_TAG} tag(断网 / 没 git):照常下载,落地后按资产自己的 gitHead 记来源"
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
    # 到 github.com 的路**会间歇性不通**:DNS 解析得出,TCP 却连不上,重试一两次
    # 才过.所以这里两件事都要有 -- 每次尝试有上界,失败了还能换一条路.四个参数
    # 各自解决一件事:
    #   --retry-all-errors  资产是**原地覆盖**同一个文件名的(见库的 release.yml),
    #                       覆盖的那一瞬间旧资产已删,新的还没上.此时的 404/5xx 是
    #                       暂时的,不该让消费者 CI 变红;真没有这个 release 时,
    #                       重试完照样明确失败.
    #   --connect-timeout   连不上时按系统默认会挂上百秒,再乘上重试次数 --
    #                       preinstall 变成"卡住好几分钟然后失败",而不是快速说清.
    #                       抖动是这种网络的常态,5 次 × 10 秒通常能撞上一次通的.
    #   --max-time          连上了却**不吐字节**(这次真遇到的另一种卡法)必须有
    #                       天花板,否则 curl 默认无限等.资产只有几十 KB,45 秒足够.
    #   --retry-delay       两次尝试之间留两秒,避开纯粹的瞬间抖动.
    log "下载 release 资产: ${ASSET_URL}"
    if ! curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors \
        --connect-timeout 10 --max-time 45 -o "${WORK}/${ASSET_NAME}" "$ASSET_URL"; then
        # 第二条路:GitHub API 的资产端点(见 download_asset_via_api).显式给过
        # MIKO_UI_ASSET_URL 时不绕行 -- 那是人明确指的路.
        if [ -n "${MIKO_UI_ASSET_URL:-}" ] || ! download_asset_via_api "${WORK}/${ASSET_NAME}"; then
            err "下载失败: ${ASSET_URL}"
            print_manual_guide '下载失败(没有这个 release / 资产名不对 / 网络不通)'
            exit 1
        fi
        log "主 URL 不通,已从 API 资产端点取回同一份资产"
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

# 4) 落地.纸条上记**资产自己声明的 commit**(清单里的 gitHead):它才是"这一份是
#    哪个 commit 构建的";tag 指向只是"下载时最新到哪"的旁证.
ASSET_REV="$(manifest_revision "${WORK}/unpack" || true)"
if [ -z "$ASSET_REV" ] && [ -z "${MIKO_UI_ASSET_FILE:-}" ]; then
    # 下载回来的这份不自证版本 -> 按"查不到"处理,口径与复用路径一致(否则 CI 的
    # 行为会取决于缓存是冷是热).手动放进去的本地资产不算,见上面 marker_is_local.
    check_unavailable "下载到的资产清单没有 gitHead(库侧还没把构建 commit 写进资产)" \
        "本次照常落地这份资产"
fi
if [ -n "$TAG_SHA" ] && [ -n "$ASSET_REV" ] && [ "$ASSET_REV" != "$TAG_SHA" ] && [ -z "${MIKO_UI_ASSET_FILE:-}" ]; then
    # 库的 release.yml 是"先传资产,再把 tag 推过去",所以刚覆盖完的一小段里两者必然
    # 不等;手动放进去的本地资产更是永远不等.两种都不影响"这是库打出来的产物",
    # 所以只报告,不失败 -- 下一次构建会再核一遍.
    warn "资产的 gitHead(${ASSET_REV:0:12})与 ${RELEASE_TAG}(${TAG_SHA:0:12})不一致:发布可能正在跑(tag 还没挪);本次照用"
fi
if [ -n "${MIKO_UI_ASSET_FILE:-}" ]; then
    printf 'local-file @ %s\n' "${ASSET_REV:-(commit 未知)}" > "${WORK}/unpack/.miko-ui-source"
else
    printf 'release %s @ %s\n' "$RELEASE_TAG" "${ASSET_REV:-${TAG_SHA:-(commit 未知)}}" > "${WORK}/unpack/.miko-ui-source"
fi
replace_dir "${WORK}/unpack"

log "产物就绪: $(source_marker "$UI_DIR")"
log "目录: ${UI_DIR}"
log "包名: $(node -p "require('${UI_DIR}/package.json').name" 2>/dev/null || echo '?')"
if [ -n "$ASSET_REV" ]; then
    log "gitHead: ${ASSET_REV}(下一次构建就拿它比 ${RELEASE_TAG})"
else
    log "gitHead:(清单里没有 -- 这份资产不自证版本;库侧带上 gitHead 后本脚本才查得了新旧)"
fi
