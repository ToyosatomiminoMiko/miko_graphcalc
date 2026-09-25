#!/usr/bin/env python3
"""
构建脚本共享底层

build.py(生产入口)与 dev_ui_link.py(本地联调)都从这里取. 抽出来的都是
"判断 / 字符串 / JSON / 文件系统"这类 shell 不擅长的部分:

  * PROJECT_ROOT / UI_PKG_NAME / 本地副本默认位置: 以前在 build.sh 与
    dev_ui_link.sh 各写一遍, 注释里还写着"改一处必须同步另一处";
  * package.json 的读取: 以前是 `node -p "require(...)"`, 为了读一个版本号
    还得依赖 node;
  * 版本同步策略 decide_ui_sync(): 策略矩阵是纯函数, 可以单独验证, 不必跑构建.

编排(按顺序调用 npm / cargo / wasm-pack)留在 build.py; 构建步骤本身的顺序依旧
由 package.json 的 build:all 定义, 这里不重复.

需要 Python 3.10+
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from enum import Enum
from pathlib import Path

# scripts/buildlib.py -> scripts -> 仓库根
PROJECT_ROOT = Path(__file__).resolve().parent.parent

UI_PKG_NAME = "miko_ui"
# 本地工作副本默认位置: 仓库根的上层目录 ../__projects_web/miko_ui
DEFAULT_UI_RELATIVE = Path("..") / "__projects_web" / UI_PKG_NAME

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_USAGE = 2
EXIT_MISSING_COMMAND = 127


class BuildError(Exception):
    """构建失败: messages 逐条打成 [ERROR] 日志, exit_code 成为进程退出码."""

    def __init__(self, *messages, exit_code=EXIT_FAIL):
        self.messages = [message for message in messages if message]
        self.exit_code = exit_code
        super().__init__(" ".join(self.messages) or "build failed")


class Logger:
    """分阶段日志前缀, 输出格式与旧 bash 脚本逐字一致.

    build.py:    [BUILD][2025.09.25.14:00:00] msg   / [BUILD][ERROR][...] msg
    dev_ui_link: [UI-LINK] msg                       / [UI-LINK][ERROR] msg
    """

    def __init__(self, tag, with_timestamp=True):
        self.tag = tag
        self.with_timestamp = with_timestamp

    def _render(self, level, message):
        parts = [f"[{self.tag}]"]
        if level:
            parts.append(f"[{level}]")
        if self.with_timestamp:
            parts.append(f"[{datetime.now():%Y.%m.%d.%H:%M:%S}]")
        return "".join(parts) + f" {message}"

    def log(self, message):
        print(self._render("", message), file=sys.stdout, flush=True)

    def err(self, message):
        print(self._render("ERROR", message), file=sys.stderr, flush=True)


def require_command(name):
    """缺工具时快速失败(旧 build.sh 的 require_command)."""
    if shutil.which(name) is None:
        raise BuildError(
            f"missing required command: {name}",
            exit_code=EXIT_MISSING_COMMAND,
        )


def run(command, cwd=None):
    """执行子进程并继承 stdio; 非零退出抛 CalledProcessError.

    这是旧脚本 `set -e` 的等价物: 调用方不必逐个检查返回值, 顶层 run_cli()
    会把子进程的退出码原样带出去.
    """
    return subprocess.run([str(part) for part in command], cwd=cwd, check=True)


def run_capture(command, cwd=None):
    """执行子进程并捕获 stdout; 任何失败都返回 None.

    等价于 shell 里的 `command 2>/dev/null || true`, 由调用方再判 None.
    """
    try:
        completed = subprocess.run(
            [str(part) for part in command],
            cwd=cwd,
            capture_output=True,
            text=True,
        )
    except OSError:
        return None
    if completed.returncode != 0:
        return None
    return completed.stdout


def run_cli(logger, body):
    """CLI 顶层错误处理, 统一退出码语义.

    BuildError         -> 逐条打 [ERROR] 日志, 用它自己的 exit_code;
    FileNotFoundError  -> 缺工具, 退出码 127(require_command 没覆盖到的那些);
    CalledProcessError -> 带出子进程的退出码(旧脚本也是这个行为);
    Ctrl-C             -> 130.
    """
    try:
        return body()
    except BuildError as exc:
        for message in exc.messages:
            logger.err(message)
        return exc.exit_code
    except FileNotFoundError as exc:
        logger.err(f"missing required command: {exc.filename}")
        return EXIT_MISSING_COMMAND
    except subprocess.CalledProcessError as exc:
        command = " ".join(str(part) for part in exc.cmd)
        logger.err(f"command failed (exit {exc.returncode}): {command}")
        return exc.returncode or EXIT_FAIL
    except KeyboardInterrupt:
        logger.err("interrupted")
        return 130


def _package_field(package_json, field):
    """读 package.json 里的一个字符串字段; 文件缺失或不是 JSON 时返回 None."""
    try:
        with open(package_json, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    value = data.get(field)
    return value if isinstance(value, str) else None


def ui_package_name(ui_dir):
    return _package_field(Path(ui_dir) / "package.json", "name")


def ui_version(ui_dir):
    return _package_field(Path(ui_dir) / "package.json", "version")


def resolve_ui_dir(environ=None):
    """本地 miko_ui 工作副本位置: MIKO_UI_DIR 优先, 否则 ../__projects_web/miko_ui.

    相对路径按仓库根解析(旧脚本靠开头的 `cd "$PROJECT_ROOT"` 达到同样效果).
    """
    environ = os.environ if environ is None else environ
    override = environ.get("MIKO_UI_DIR")
    if not override:
        return PROJECT_ROOT / DEFAULT_UI_RELATIVE
    path = Path(override).expanduser()
    return path if path.is_absolute() else PROJECT_ROOT / path


def git_state(ui_dir):
    """(短 commit, 未提交文件数); 副本不是 git 工作树时返回 ("unknown", "?").

    只有在副本确实是个 git 工作树时才报 commit: 否则 git 的失败不该有权力把
    整条构建带停(日志里那句 commit/dirty 是给人看的, 不该有这种权力).
    """
    ui_dir = str(ui_dir)
    if shutil.which("git") is None:
        return ("unknown", "?")
    if run_capture(["git", "-C", ui_dir, "rev-parse", "--git-dir"]) is None:
        return ("unknown", "?")
    head = (
        run_capture(["git", "-C", ui_dir, "rev-parse", "--short", "HEAD"]) or ""
    ).strip()
    porcelain = run_capture(["git", "-C", ui_dir, "status", "--porcelain"]) or ""
    dirty = str(sum(1 for line in porcelain.splitlines() if line.strip()))
    return (head or "unknown", dirty)


def metadata_fingerprint(directory):
    """package.json + package-lock.json 的内容指纹.

    用来证明某套操作没有改到这两个被跟踪的文件; 失败时不是"修复", 而是把问题
    喊出来让人看 git diff.
    """
    digest = hashlib.sha256()
    for name in ("package.json", "package-lock.json"):
        try:
            digest.update((Path(directory) / name).read_bytes())
        except OSError:
            pass
    return digest.hexdigest()


def remove_path(path):
    """rm -rf 语义, 但不跟随符号链接(删链接本身, 不删它指向的目录)."""
    path = Path(path)
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


class SyncAction(Enum):
    """版本同步策略的输出, 由 build.py 翻译成日志与动作."""

    KEEP_LOCKED = "keep_locked"
    LATEST_UNAVAILABLE = "latest_unavailable"
    ALREADY_LATEST = "already_latest"
    OUTDATED_CHECK = "outdated_check"
    OUTDATED_UPDATE = "outdated_update"


def decide_ui_sync(mode, locked, latest, *, must_resolve_latest):
    """版本同步策略矩阵(纯函数, 完整背景见 build.py 的 sync_miko_ui 文档).

    前提: mode 已限定为 auto|check -- off 与非法值在取版本号之前就返回了, 这样
    `MIKO_UI_SYNC=off` 不会去碰网络.

    locked / latest 为 None 表示读不到; must_resolve_latest 为真表示这次构建不
    允许"说不清哪一版"(CI, 或显式 MIKO_UI_REQUIRE_LATEST=1).
    """
    if not latest:
        if must_resolve_latest:
            return SyncAction.LATEST_UNAVAILABLE
        return SyncAction.KEEP_LOCKED
    if locked == latest:
        return SyncAction.ALREADY_LATEST
    if mode == "check":
        return SyncAction.OUTDATED_CHECK
    return SyncAction.OUTDATED_UPDATE
