#!/usr/bin/env python3
"""生产构建入口.

负责"安装锁定依赖", "决定这次用哪份 miko_ui"和"调用统一流水线"; 真正的
构建/检查步骤序列定义在 package.json 的 build:all 脚本(单一事实源, 避免两处
重复).

用法: bash ./build.sh [--ui local|npm] (--help 有完整说明)
  bash ./build.sh              本机: 默认用本地 miko_ui 工作副本(本地联调走的这条)
  bash ./build.sh --ui npm     本机: 用 npm 上发布的那一版
  bash ./build.sh              CI: 不带参数也是 npm, 不该依赖谁记得加参数;
                               显式要 local 会被拒绝, 绝不构建工作副本

为什么要保留 bash 外壳而不是内联到 CI:
  * 提供本地入口(bash ./build.sh 与 CI 走同一条; 想严格按 lock 构建就设
    MIKO_UI_SYNC=off);
  * 覆盖 npm run 无法提供的缺工具快速失败(require_command)与分阶段日志前缀.

为什么外壳里面是 Python: 这个脚本的代码量几乎都在"判断 / 字符串 / JSON /
文件系统"上(shell 最不擅长的部分), 真正的编排只有下面 run_build() 里那十来行
kit.run(). 版本同步的策略矩阵单独抽成 buildlib.decide_ui_sync() 这个纯函数,
不必通读分支就能看清每种组合的结论.
"""
from __future__ import annotations

import argparse
import os
import sys

import buildlib as kit
import dev_ui_link

LOG = kit.Logger("BUILD")
ROOT = kit.PROJECT_ROOT

# 旧 build.sh 里 require_command 的顺序, 保持逐字一致.
REQUIRED_COMMANDS = ("node", "npm", "cargo", "wasm-pack")

DESCRIPTION = """\
  --ui local    用本地 miko_ui 工作副本构建: 先重建副本的 dist/, 再把
                node_modules/miko_ui 链接到副本. 链接会一直留着, 所以构建完
                自己跑 npx vite 看到的就是本地库.
                本机不带 --ui 时默认走这条; 在 CI 里显式要它会被拒绝.
  --ui npm      用 npm 上发布的 miko_ui 构建, 并把版本对齐到 npm latest.
                CI / GitHub Pages 不带 --ui 时默认走这条, 所以 deploy.yml 里
                直接写 bash ./build.sh 就是发布形态.
                跑完这一条 node_modules/miko_ui 也就还原成 npm 版了."""

EPILOG = """\
环境变量:
  MIKO_UI_SOURCE=local|npm     等价于 --ui(命令行优先)
  MIKO_UI_DIR=<path>           本地副本位置, 默认 ../__projects_web/miko_ui
  MIKO_UI_SYNC=auto|check|off  只对 npm 那一份有效(见 README 的版本同步注释)
  CI=<非空>                    视为 CI: 不带 --ui 时默认 npm, 且拒绝 local"""


def parse_args(argv):
    parser = argparse.ArgumentParser(
        prog="bash ./build.sh",
        usage="%(prog)s [--ui local|npm]",
        description=DESCRIPTION,
        epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        allow_abbrev=False,
    )
    parser.add_argument(
        "--ui",
        choices=("local", "npm"),
        default=None,
        help="用哪一份 miko_ui 构建; 命令行优先于 MIKO_UI_SOURCE; 不带时本机默认 local, CI 默认 npm",
    )
    parser.add_argument(
        "--ui-local",
        dest="ui",
        action="store_const",
        const="local",
        help="等价于 --ui local(兼容旧写法)",
    )
    return parser.parse_args(argv)


# resolve_ui_source 的第二个返回值 -> 日志里那句"为什么选它".
UI_ORIGIN_NOTE = {
    "explicit": "selected by --ui / MIKO_UI_SOURCE",
    "ci-default": "CI defaults to npm",
    "local-default": "local default",
}


def resolve_ui_source(cli_value, environ):
    """(用哪份 UI, 为什么这么定).

    显式选择(--ui 或 MIKO_UI_SOURCE)永远优先. 没显式选择时: CI 上一定是 npm --
    推上去的生产环境不该依赖谁记得加参数; 本机默认本地工作副本, 因为本地联调要
    的就是它. 第二个返回值只用于日志说明来源.
    """
    explicit = cli_value or environ.get("MIKO_UI_SOURCE")
    if explicit:
        if explicit not in ("local", "npm"):
            raise kit.BuildError(
                f"invalid UI source '{explicit}' (expected npm|local)",
                exit_code=kit.EXIT_USAGE,
            )
        return explicit, "explicit"
    if environ.get("CI"):
        return "npm", "ci-default"
    return "local", "local-default"


def require_local_ui(ui_dir):
    """副本必须是个 miko_ui 工作树, 并且要在 npm ci 之前就确认.

    检查放在安装之前: 早点失败, 不必先等一遍完整安装.
    """
    if not (ui_dir / "package.json").is_file():
        raise kit.BuildError(
            f"no {kit.UI_PKG_NAME} checkout at {ui_dir} (that is the default UI source); either",
            "point MIKO_UI_DIR at the checkout, or build from npm: bash ./build.sh --ui npm",
        )
    name = kit.ui_package_name(ui_dir)
    if name != kit.UI_PKG_NAME:
        display = name or "?"
        raise kit.BuildError(
            f"{ui_dir} is not the {kit.UI_PKG_NAME} checkout (package.json name='{display}')"
        )


def npm_latest():
    """npm view miko_ui@latest version 的第一行; 断网或 npm 失败时返回 None."""
    output = kit.run_capture(["npm", "view", f"{kit.UI_PKG_NAME}@latest", "version"], cwd=ROOT)
    if not output:
        return None
    for line in output.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return None


def sync_miko_ui(environ):
    """把 miko_ui 对齐到 npm 的 latest(只对 --ui npm 有效).

    库在 npm 上独立发版, package-lock.json 不会自己跟着走. 这一步在锁定依赖装
    好之后, 把 miko_ui 对齐到 npm 的 latest:

      MIKO_UI_SYNC=auto  (默认) 落后就 npm install miko_ui@latest, 并更新
                                package.json / package-lock.json
                                (本地跑完记得提交这两个文件);
      MIKO_UI_SYNC=check        落后就失败, 不改任何文件(只想校验时用);
      MIKO_UI_SYNC=off          完全按 lock 构建, 跳过这一步.

    查不到 latest(断网 / npm 不可用)时: 本机警告并沿用 lock; CI(CI=true, 或显式
    MIKO_UI_REQUIRE_LATEST=1)明确失败 -- 部署出去的必须是能说清哪一版的产物.
    想跳过网络查询(测试这一步)可以预设 MIKO_UI_LATEST_VERSION.

    off 与非法值在取版本号之前就返回, 所以 MIKO_UI_SYNC=off 不会去碰网络.
    """
    mode = environ.get("MIKO_UI_SYNC") or "auto"
    if mode == "off":
        LOG.log("miko_ui sync skipped (MIKO_UI_SYNC=off)")
        return
    if mode not in ("auto", "check"):
        raise kit.BuildError(f"invalid MIKO_UI_SYNC='{mode}' (expected auto|check|off)")

    locked = kit.ui_version(ROOT / "node_modules" / kit.UI_PKG_NAME)
    latest = environ.get("MIKO_UI_LATEST_VERSION") or npm_latest()
    must_resolve = bool(environ.get("CI")) or environ.get("MIKO_UI_REQUIRE_LATEST") == "1"
    action = kit.decide_ui_sync(mode, locked, latest, must_resolve_latest=must_resolve)
    locked_display = locked or "unknown"

    if action is kit.SyncAction.LATEST_UNAVAILABLE:
        raise kit.BuildError(
            f"cannot resolve the latest {kit.UI_PKG_NAME} from npm, "
            "and this build must not ship a stale version"
        )
    if action is kit.SyncAction.KEEP_LOCKED:
        LOG.log(
            f"WARN: cannot resolve the latest {kit.UI_PKG_NAME} from npm; "
            f"continuing with locked {locked_display}"
        )
        return
    if action is kit.SyncAction.ALREADY_LATEST:
        LOG.log(f"miko_ui is already the latest ({latest})")
        return
    if action is kit.SyncAction.OUTDATED_CHECK:
        raise kit.BuildError(
            f"{kit.UI_PKG_NAME} is {locked_display} but npm latest is {latest}; "
            f"run 'npm install {kit.UI_PKG_NAME}@latest'"
        )

    LOG.log(f"updating {kit.UI_PKG_NAME}: {locked_display} -> {latest}")
    kit.run(
        ["npm", "install", f"{kit.UI_PKG_NAME}@{latest}", "--no-audit", "--no-fund"],
        cwd=ROOT,
    )
    LOG.log(
        f"miko_ui is now {kit.ui_version(ROOT / 'node_modules' / kit.UI_PKG_NAME)} "
        "(package.json / package-lock.json changed; commit them when building locally)"
    )


def build_and_link_local_ui(ui_dir):
    """本地 UI 模式: 先重建副本的 dist/, 再把它链接进来.

    顺序不能反: dev_ui_link 会校验 dist/index.js 存在, 而且接下来整条流水线要用
    的就是刚出的这一份. 库怎么构建由库自己说了算, 这里只调用它自己的
    `npm run build:dist`, 不在这里写 tsc 参数.
    """
    if not os.access(ui_dir / "node_modules" / ".bin" / "tsc", os.X_OK):
        raise kit.BuildError(
            f"{ui_dir}/node_modules is missing; install the library's own dependencies first:",
            f"    cd {ui_dir} && npm install",
        )

    LOG.log(f"building local miko_ui dist (npm run build:dist in {ui_dir})")
    kit.run(["npm", "run", "build:dist"], cwd=ui_dir)

    version = kit.ui_version(ui_dir)
    head, dirty = kit.git_state(ui_dir)
    LOG.log(f"local miko_ui: version {version}, commit {head}, {dirty} uncommitted file(s)")

    dev_ui_link.link(ui_dir)


def run_build(argv):
    """整条流水线. 步骤顺序与旧 build.sh 一一对应, 见各处注释."""
    args = parse_args(argv)
    environ = os.environ
    ui_source, origin = resolve_ui_source(args.ui, environ)

    for name in REQUIRED_COMMANDS:
        kit.require_command(name)

    ui_dir = kit.resolve_ui_dir(environ)

    if ui_source == "local":
        # 到这里还是 local, 就说明是显式选的(--ui local 或 MIKO_UI_SOURCE=local):
        # 不带参数时 CI 已经自动走 npm 了. CI 上要工作副本一律拒绝, 免得哪天把
        # 未发布的副本构建部署出去.
        if environ.get("CI"):
            raise kit.BuildError(
                "refusing an explicit local UI source under CI; "
                "CI builds use the published package"
            )
        require_local_ui(ui_dir)

    LOG.log("installing pinned dependencies from package-lock.json")
    # 依赖全部来自 npm registry: miko_ui 是上游库
    # (https://github.com/ToyosatomiminoMiko/miko_ui)发布到 npm 的包.
    #
    # 再往下 build:all 的顺序是 lint:rs -> clean -> build:wasm -> test -> build:app;
    # 其中 clean 只删根 dist/ 与 src/generated/, 不碰 node_modules.
    # 生产构建里唯一一份 miko_ui / @preact/signals-core 的实例约束见
    # vite.config.ts 的 resolve.dedupe.
    kit.run(["npm", "ci", "--no-audit", "--no-fund"], cwd=ROOT)

    if ui_source == "local":
        # 本地模式不查 npm: 那一步的意义是对齐 npm latest, 这里要的是工作副本.
        LOG.log("UI source: local checkout (npm version sync skipped)")
        build_and_link_local_ui(ui_dir)
    else:
        # 装完锁定依赖后再对齐 miko_ui: 增量装一个包, 不必推倒 node_modules 重来.
        LOG.log(f"UI source: npm published package ({UI_ORIGIN_NOTE[origin]})")
        sync_miko_ui(environ)

    # 流水线 = lint:rs -> clean -> build:wasm -> test -> build:app
    # (后者内含 typecheck + vite build)
    LOG.log("running full build pipeline (lint -> clean -> wasm -> test -> app)")
    kit.run(["npm", "run", "build:all"], cwd=ROOT)

    LOG.log("build succeeded")
    if ui_source == "local":
        LOG.log("node_modules/miko_ui is still linked to the local checkout: 'npx vite' serves it")
    LOG.log(f"output directory: {ROOT / 'dist'}")
    return kit.EXIT_OK


def main(argv):
    return kit.run_cli(LOG, lambda: run_build(argv))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
