#!/usr/bin/env python3
# ============================================================================
# 提交前把中文全角标点转成半角
# ----------------------------------------------------------------------------
# 由 .githooks/pre-commit 对本次暂存的每个文本文件调用(文件模式,原地改写).
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
# [工作原理(.githooks/pre-commit)]
#   git diff --cached --name-only -z --diff-filter=ACM
#     -> 取出本次暂存的新增/修改/复制文件(不含删除)
#     -> 对每个文件执行 python3 scripts/autorun.py <file>(文件模式,原地改写)
#     -> 再 git add 回暂存区,让修正结果直接进入这一次提交
#
# [为什么可以对自己生效]
#   - CHAR_MAP 的左值一律写成 \uXXXX 转义(见下方),源文件里不含全角字面量,
#     所以本文件被自己扫描一遍之后映射表依旧完好.改动映射表时不要退回字面量
#     写法,否则字典会被自己改写(比如键 \uff09 若写成字面量,会连同引号一起
#     被替换成半角).
#   - 本文件的注释统一使用半角标点,转换因此幂等,不会每次提交都产生无意义 diff.
#   - .githooks/pre-commit 也在修正范围内,但它必须等循环结束,bash 把脚本读完
#     之后再改写(边执行边重写正在运行的 shell 脚本是危险的);本文件由 python
#     整体读入并编译后才执行,当场改写是安全的.
#
# [注意事项]
#   * 二进制文件读取时抛 UnicodeDecodeError,直接跳过,不影响提交.
#   * 没装 python3 的环境: hook 打印警告并放行提交(不阻断别人).
#   * 文件模式会真的改写工作区文件(再 git add 回暂存区),所以 git status 未必
#     看得到差异,但磁盘内容已经变了.
#   * 无参数调用时是管道模式: stdin -> stdout,可配合编辑器/其他脚本使用.
# ============================================================================
import sys
import re

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


if __name__ == "__main__":
    if len(sys.argv) > 1:
        # 文件模式:直接修改,支持一次传多个文件
        failed = False
        for filepath in sys.argv[1:]:
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    content = f.read()
            except UnicodeDecodeError:
                continue  # 二进制文件不处理
            except Exception as e:
                print(f"[fix_punctuation] error: {filepath}: {e}", file=sys.stderr)
                failed = True
                continue

            new_content = transform(content)
            if content != new_content:
                with open(filepath, "w", encoding="utf-8") as f:
                    f.write(new_content)
                print(f"[fix_punctuation] fixed: {filepath}")

        if failed:
            sys.exit(1)
    else:
        # 管道模式
        data = sys.stdin.read()
        sys.stdout.write(transform(data))
