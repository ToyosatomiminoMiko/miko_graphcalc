#!/usr/bin/env python3
# ============================================================================
# 提交前把中文全角标点转成半角
# ----------------------------------------------------------------------------
# 两种用法:
#
#   .githooks/pre-commit(git 钩子)把它当**库**导入, 调 fix_file() 处理本次
#   暂存的每个文本文件(原地改写). 钩子自己负责 git 那一侧(diff --cached / add).
#   本仓库的钩子是 bash, 走下面的命令行"文件模式"; 改成 Python 钩子后直接
#   import 本模块即可(fix_file() 的返回值就是"有没有被改写").
#
#   命令行单独用:
#       python3 scripts/autorun.py <file> [<file>...]   # 文件模式, 原地改写
#       python3 scripts/autorun.py < in > out           # 管道模式(stdin -> stdout)
#
# [为什么 hook 放在版本库里]
# .git/hooks 不进版本库,换机器或重新 clone 后自动运行会静默失效.改用
# .githooks/ + core.hooksPath: hook 跟随仓库提交,谁 clone 下来用同一条
# 命令就能启用.
#
# [启用(每个 clone 各做一次)]
#     npm install            # 或 npm ci:prepare 会先 build,再执行下一条
#     或手动: git config --local core.hooksPath .githooks
#     确认:   git config --get core.hooksPath        # 应输出 .githooks
# 之后每次 git commit 都会运行 .githooks/pre-commit.
#
#   临时跳过某次提交:  git commit --no-verify
#   卸载:              git config --unset core.hooksPath
#   单独调试 hook:     git hook run pre-commit
#
# [为什么可以对自己生效]
#   - CHAR_MAP 的左值一律写成 \uXXXX 转义(见下方),源文件里不含全角字面量,
#     所以本文件被自己扫描一遍之后映射表依旧完好.改动映射表时不要退回字面量
#     写法,否则字典会被自己改写(比如键 \uff09 若写成字面量,会连同引号一起
#     被替换成半角).
#   - 本文件的注释统一使用半角标点,转换因此幂等,不会每次提交都产生无意义 diff.
#   - 钩子那边没有"正在运行的脚本被改写"的问题: CPython 在执行前就把整个源文件
#     读入并编译完, 之后再改写磁盘上的 `pre-commit` 或本文件都已无影响(原始的
#     bash 钩子做不到这一点, 所以它当时必须把钩子文件单独排到最后处理).
#
# [注意事项]
#   * 二进制文件读取时抛 UnicodeDecodeError,调用方跳过,不影响提交.
#   * 钩子本身是 Python: 没装 python3 的机器上 git 会直接报 "bad interpreter",
#     比"钩子静默不生效"更容易发现; 真要停用就 `git config --unset core.hooksPath`.
#   * 文件模式会真的改写工作区文件(钩子随后把改过的 `git add` 回暂存区),所以
#     git status 未必看得到差异,但磁盘内容已经变了.
#   * 读写都用 newline='': 原样保留 CRLF/LF, 不会因为"顺手规范化换行"而把整个
#     文件变成一次无关 diff.
# ============================================================================
import re
import sys

# 全角标点 -> ASCII 映射表;键一律写成 \uXXXX 转义(见上"为什么可以对自己生效").
CHAR_MAP = {
    "\uff09": ")",  # 全角右圆括号 -> 半角右圆括号
    "\uff08": "(",  # 全角左圆括号 -> 半角左圆括号
    "\uff0c": ",",  # 全角逗号 -> 半角逗号
    "\u3002": ".",  # 全角句号 -> 半角句点
    "\u201c": '"',  # 全角左双引号 -> 半角双引号
    "\u201d": '"',  # 全角右双引号 -> 半角双引号
    "\u2018": "'",  # 全角左单引号 -> 半角单引号
    "\u2019": "'",  # 全角右单引号 -> 半角单引号
    "\uff1b": ";",  # 全角分号 -> 半角分号
    "\u2014": "-",  # 全角破折号 -> 半角连字符
    "\uff1a": ":",  # 全角冒号 -> 半角冒号
    "\u3001": ",",  # 全角顿号 -> 半角逗号
    "\u2192": "->",  # 全角箭头 -> 半角箭头
    "\u3011": "]",  # 全角右方括号 -> 半角右方括号
    "\u3010": "[",  # 全角左方括号 -> 半角左方括号
    "\u2026": "...",  # 全角省略号 -> 三个半角点
    "\uff1f": "?",  # 全角问号 -> 半角问号
    "\uff01": "!",  # 全角叹号 -> 半角叹号
    "\u3008": "<",  # 全角左尖括号 -> 半角小于号
    "\u3009": ">",  # 全角右尖括号 -> 半角大于号
    "\u300a": "<<",  # 全角左书名号 -> 两个半角小于号
    "\u300b": ">>",  # 全角右书名号 -> 两个半角大于号
    "\uff5e": "~",  # 全角波浪号 -> 半角波浪号
}

# 键都是单字符,交替匹配不存在前缀冲突,无需按长度排序;re.escape 保证字面量安全.
pattern = re.compile("|".join(re.escape(k) for k in CHAR_MAP.keys()))


def transform(text):
    return pattern.sub(lambda m: CHAR_MAP[m.group(0)], text)


def fix_file(filepath):
    """原地转换一个文件,返回它是否真的被改写.

    返回 True  = 内容里有全角标点,文件已就地改写;
    返回 False = 内容本来就合规,盘上没动.

    二进制文件抛 UnicodeDecodeError,由调用方决定怎么处理(钩子与命令行都选择
    跳过): 本函数不替调用方吞掉这个信号, 否则调用方分不清"跳过了"和"没问题".
    """
    with open(filepath, "r", encoding="utf-8", newline="") as f:
        content = f.read()

    new_content = transform(content)
    if content == new_content:
        return False

    with open(filepath, "w", encoding="utf-8", newline="") as f:
        f.write(new_content)
    return True


def main(argv):
    if argv:
        # 文件模式:直接修改,支持一次传多个文件
        failed = False
        for filepath in argv:
            try:
                changed = fix_file(filepath)
            except UnicodeDecodeError:
                continue  # 二进制文件不处理
            except OSError as err:
                print(f"[fix_punctuation] error: {filepath}: {err}", file=sys.stderr)
                failed = True
                continue

            if changed:
                print(f"[fix_punctuation] fixed: {filepath}")

        return 1 if failed else 0

    # 管道模式
    sys.stdout.write(transform(sys.stdin.read()))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
