#!/usr/bin/env bash
# 本地联调 miko_ui 的壳. 真正的逻辑在 scripts/dev_ui_link.py(见那里的模块说明).
#
# 用法: bash scripts/dev_ui_link.sh [link|unlink|status]   (默认 link)
# 这个入口在 README 里写着, 所以保留; 完全等价于
# python3 scripts/dev_ui_link.py ...
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v python3 >/dev/null 2>&1; then
    printf '[UI-LINK][ERROR] missing required command: python3\n' >&2
    exit 127
fi

exec python3 "${SCRIPT_DIR}/dev_ui_link.py" "$@"
