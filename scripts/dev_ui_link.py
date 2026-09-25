#!/usr/bin/env python3
"""本地联调 miko_ui: 把 node_modules/miko_ui 换成指向本地工作副本的符号链接.
============================================================================
[为什么需要它]
应用依赖的是发布在 npm 上的 miko_ui, GitHub Pages 的部署也只能走 npm(见
README 的"构建"一节与 .github/workflows/deploy.yml). 但改库的时候
"改一行 -> 发一版 -> 回来更新 lock" 这条环路太长. 这一步只在**本地**把解析
目标换成工作副本:

  * 只动 node_modules/(gitignore), 不碰 package.json 与 package-lock.json;
  * 不动 build.sh / deploy.yml, 所以 gh-pages 与 CI 的行为一个字节都不变;
  * npm ci(或 bash ./build.sh --ui npm)就能还原成 npm 上那一版.

之所以这样做而不是把 "file:../..." 写进 package.json: CI 上没有那个路径, 仓库
里一旦留下本地依赖, Pages 构建会直接失败. 链接只存在于被忽略的 node_modules/
里, 没有这个风险.

[用法]
  bash scripts/dev_ui_link.sh link     # 链接到本地副本(默认动作)
  bash scripts/dev_ui_link.sh unlink   # 还原成 npm 版(按 lock 重装)
  bash scripts/dev_ui_link.sh status   # 看当前解析到哪一份

scripts/dev_ui_link.sh 只是个壳, 逻辑在本文件; 也可以直接
`python3 scripts/dev_ui_link.py link`.

平时不用直接调它: `bash ./build.sh`(不带参数就是本地副本)会重建副本的 dist/
再调这里的 link. 单独用它的场合是"只想链接,不想跑整条流水线", 以及
status / unlink 这种排查动作.

工作副本位置默认 ../__projects_web/miko_ui(相对仓库根的上一层), 用
MIKO_UI_DIR 覆盖:
  MIKO_UI_DIR=/path/to/miko_ui bash scripts/dev_ui_link.sh link

[链接之后怎么用]
  * 库的 styles/ 是原样发布的(库的 exports 直接映射到 styles/*.css), 改完
    **零构建立即生效**;
  * 库的 src/ 要先编译进 dist/, 两条路:
        bash ./build.sh                   # 默认: 重建副本 dist/ + 跑完整流水线
        或 在库里常驻 npx tsc -p tsconfig.build.json --watch
    (两种别同时用: build:dist 开头会 clean, 和常驻的 watch 会打架);
  * Vite 会把 root 外已加载的模块加进自己的 watcher, 所以保存后会自动刷新,
    不需要配 server.fs.allow(见本仓库 vite.config.ts 的 dedupe 说明).

[三个已知坑]
  1. node_modules/.vite 里可能有上一轮按 npm 包预打包的产物
     (deps/miko___ui.js), 链接切换前后不清它, 表现是"改了库但页面没动".
     本脚本在 link / unlink 时都会删掉这个缓存目录.
  2. 不带参数的 build.sh 默认就走本地副本, 它开头是 npm ci(会把链接冲掉)但随后
     会重建副本 dist/ 并重新链接; 要回到 npm 上那一版就走
     bash ./build.sh --ui npm(或 npm ci), 那会把链接换成 npm 版.
  3. 本地 npm test 也会跟着用工作副本(cssPalette.test.ts /
     editorStyles.test.ts 直接读库的 styles/), 所以"本地绿"不等于"CI 绿".
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

import buildlib as kit

LOG = kit.Logger("UI-LINK", with_timestamp=False)
LINK_PATH = kit.PROJECT_ROOT / "node_modules" / kit.UI_PKG_NAME
VITE_CACHE = kit.PROJECT_ROOT / "node_modules" / ".vite"


def require_ui_checkout(ui_dir):
    """链接前的三道校验: 有 package.json / 确实是 miko_ui / dist 已编译."""
    ui_dir = Path(ui_dir)
    if not (ui_dir / "package.json").is_file():
        raise kit.BuildError(
            f"no library checkout at {ui_dir} (set MIKO_UI_DIR to point at it)"
        )
    name = kit.ui_package_name(ui_dir)
    if name != kit.UI_PKG_NAME:
        display = name or "?"
        raise kit.BuildError(
            f"{ui_dir} is not the {kit.UI_PKG_NAME} checkout (package.json name='{display}')"
        )
    # 应用运行时 import 的是库的 dist/, 没有它连 dev server 都起不来. 与其链上去
    # 再报一个难懂的解析错误, 不如在这里直接说清要先编译.
    if not (ui_dir / "dist" / "index.js").is_file():
        raise kit.BuildError(
            f"{ui_dir}/dist/index.js is missing; build the library first:",
            f"    cd {ui_dir} && npx tsc -p tsconfig.build.json --watch",
        )


def clear_vite_cache():
    """删掉 Vite 的依赖预打包缓存.

    链接与还原之后都必须做, 否则页面继续吃旧的预打包产物(库现在是链接进来的,
    走的是源码路径, 不预打包).
    """
    if VITE_CACHE.is_dir():
        shutil.rmtree(VITE_CACHE)
        LOG.log("cleared Vite dep cache: node_modules/.vite")


def link(ui_dir):
    """建立链接; 由 build.py 与命令行共用, 失败一律抛 BuildError."""
    require_ui_checkout(ui_dir)

    if not (kit.PROJECT_ROOT / "node_modules").is_dir():
        raise kit.BuildError("node_modules is missing; run 'npm ci' first")

    # package.json / package-lock.json 的指纹: 用来证明这整套操作没有改到跟踪
    # 文件. 失败时不是"修复", 而是把问题喊出来让人看 git diff.
    before = kit.metadata_fingerprint(kit.PROJECT_ROOT)
    target = Path(ui_dir).resolve()

    current = None
    if LINK_PATH.is_symlink():
        try:
            current = LINK_PATH.resolve()
        except OSError:
            current = None

    if current == target:
        LOG.log(f"already linked to {target}")
    else:
        # 删掉的是 npm 装的那一份目录, 不是工作副本; 要还原就走 unlink 或 npm ci.
        if LINK_PATH.exists() or LINK_PATH.is_symlink():
            LOG.log(f"replacing npm copy with a link to {target}")
        else:
            LOG.log(f"linking node_modules/{kit.UI_PKG_NAME} -> {target}")
        kit.remove_path(LINK_PATH)
        LINK_PATH.symlink_to(target)

    clear_vite_cache()

    after = kit.metadata_fingerprint(kit.PROJECT_ROOT)
    if before != after:
        raise kit.BuildError(
            "package.json / package-lock.json changed unexpectedly; "
            "check 'git diff' before committing"
        )

    LOG.log(
        f"linked: node_modules/{kit.UI_PKG_NAME} -> {target} "
        f"(version {kit.ui_version(LINK_PATH)})"
    )
    LOG.log("the app now resolves the local copy: run 'npx vite' for the local server")
    LOG.log("after editing the library's src/, rebuild its dist/ with:")
    LOG.log(f"    bash ./build.sh   (or: cd {target} && npx tsc -p tsconfig.build.json --watch)")
    LOG.log("restore the published package with: bash scripts/dev_ui_link.sh unlink (or npm ci)")


def unlink():
    """还原成 npm 版: 删链接, 再按 package-lock.json 增量装回来."""
    if LINK_PATH.is_symlink():
        LINK_PATH.unlink()
        LOG.log(f"removed the link at node_modules/{kit.UI_PKG_NAME}")
    elif LINK_PATH.exists():
        LOG.log(f"node_modules/{kit.UI_PKG_NAME} is not a link; nothing to unlink")
        return

    before = kit.metadata_fingerprint(kit.PROJECT_ROOT)
    LOG.log(f"reinstalling {kit.UI_PKG_NAME} from package-lock.json")
    kit.run(["npm", "install", "--no-audit", "--no-fund"], cwd=kit.PROJECT_ROOT)
    after = kit.metadata_fingerprint(kit.PROJECT_ROOT)
    if before != after:
        raise kit.BuildError(
            "npm install changed package.json / package-lock.json; "
            "check 'git diff' before committing"
        )

    clear_vite_cache()
    LOG.log(
        f"{kit.UI_PKG_NAME} is back to the published version: "
        f"{kit.ui_version(LINK_PATH) or 'unknown'}"
    )


def metadata_dirty():
    """package.json / package-lock.json 在 git 里是否有未提交改动."""
    output = kit.run_capture(
        [
            "git", "-C", str(kit.PROJECT_ROOT), "status", "--porcelain",
            "--", "package.json", "package-lock.json",
        ]
    )
    return bool(output and output.strip())


def status():
    """看当前 node_modules/miko_ui 解析到哪一份, 以及有没有残留的预打包缓存."""
    if LINK_PATH.is_symlink():
        LOG.log(f"resolves to the local checkout: {LINK_PATH.resolve()}")
    elif LINK_PATH.exists():
        LOG.log(f"resolves to the npm package: version {kit.ui_version(LINK_PATH)}")
    else:
        LOG.log("not installed (run npm ci)")

    if VITE_CACHE.is_dir():
        LOG.log("Vite dep cache exists: node_modules/.vite")

    if shutil.which("git") is not None and metadata_dirty():
        LOG.log("WARN: package.json / package-lock.json have uncommitted changes")


def main(argv):
    action = argv[0] if argv else "link"

    def body():
        if action == "link":
            link(kit.resolve_ui_dir())
        elif action == "unlink":
            unlink()
        elif action == "status":
            status()
        else:
            raise kit.BuildError(f"unknown action '{action}' (expected link|unlink|status)")
        return kit.EXIT_OK

    return kit.run_cli(LOG, body)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
