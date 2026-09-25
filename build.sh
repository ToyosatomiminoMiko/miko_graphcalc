#!/usr/bin/env bash
# 生产构建入口的壳. 真正的逻辑在 scripts/build.py(见那里的模块说明):
# 安装锁定依赖 -> 决定这次用哪份 miko_ui -> 调用 package.json 的 build:all.
#
# 为什么保留这个壳: `bash ./build.sh ...` 这个入口被 README 与
# .github/workflows/deploy.yml 依赖, 不能改; 参数与环境变量语义与旧版逐字兼容
# (--ui local|npm, --ui-local, -h/--help, MIKO_UI_SOURCE / MIKO_UI_DIR /
# MIKO_UI_SYNC / MIKO_UI_LATEST_VERSION / MIKO_UI_REQUIRE_LATEST).
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# python3 是构建的硬依赖: 先把"缺工具快速失败"这一条提供出来, 否则连壳都进不去.
if ! command -v python3 >/dev/null 2>&1; then
    printf '[BUILD][ERROR][%s] missing required command: python3\n' "$(date '+%Y.%m.%d.%H:%M:%S')" >&2
    exit 127
fi

exec python3 "${PROJECT_ROOT}/scripts/build.py" "$@"
