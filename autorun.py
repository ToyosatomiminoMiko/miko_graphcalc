#!/usr/bin/env python3
# ============================================================================
# 提交前自动把中文全角标点转成半角
# ----------------------------------------------------------------------------
# 这份脚本现在由 git 自动运行,而且它自己也在修正范围内(工具对自己生效).
#
# [为什么以前不算"git 里配好的"]
# 以前它虽然放在仓库根目录,却被 .gitignore 忽略;hook 也只存在于本机的
# .git/hooks/pre-commit 里(.git/hooks 永远不进版本库). 结果是换机器或重新
# clone 之后自动运行会静默失效,而且没有任何提示.
#
# 现在改成"版本库内的 .githooks/ + core.hooksPath": hook 跟随仓库一起被提交,
# 谁 clone 下来都能用同一条命令启用.
#
# [启用自动运行(每个 clone 各做一次)]
#     1) npm install              # package.json 的 prepare 会自动执行第 2 步
#        或手动执行:
#        git config --local core.hooksPath .githooks
#     2) 确认已生效:
#        git config --get core.hooksPath        # 应输出 .githooks
#     3) 之后每次 git commit 都会自动运行 .githooks/pre-commit
#
#   临时跳过某次提交:  git commit --no-verify
#   卸载:              git config --unset core.hooksPath
#   单独调试 hook:     git hook run pre-commit
#
# [工作原理(.githooks/pre-commit)]
#   git diff --cached --name-only -z --diff-filter=ACM
#     -> 取出本次暂存的新增/修改/复制文件(不含删除)
#     -> 对每个文件执行 python3 autorun.py <file>(文件模式,原地改写)
#     -> 再 git add 回暂存区,让修正结果直接进入这一次提交
#
# [为什么可以对自己生效]
#   CHAR_MAP 的左值一律写成 \uXXXX 转义(见下方),源文件里不含全角字面量,
#   所以本文件被自己扫描一遍之后映射表依旧完好. 这是能自我处理的关键前提,
#   以后改动映射表时请不要退回字面量写法,否则字典会被自己改写掉
#   (比如键 \uff09 若写成字面量,会连同引号一起被替换成半角).
#   本文件的注释也统一使用半角标点,因此转换是幂等的,不会每次提交都产生
#   无意义的 diff.
#
# [注意事项]
#   * .githooks/pre-commit 同样在修正范围内,但它必须等循环结束,bash 把脚本
#     读完之后再改写: 边执行边重写正在运行的 shell 脚本是危险的.
#     (本文件由 python 整体读入并编译后才执行,当场改写是安全的,无需延后)
#   * 二进制文件读取时抛 UnicodeDecodeError,直接跳过,不影响提交.
#   * 没装 python3 的环境: hook 打印警告并放行提交(不阻断别人).
#   * 这是"文件模式",脚本会真的改写工作区文件,只是顺手帮你 git add 了,
#     所以 git status 未必看得到差异,但磁盘内容已经变了.
#   * 无参数调用时是"管道模式": stdin -> stdout,可配合编辑器/其他脚本使用.
# ============================================================================
import sys
import re

# 你的映射规则
CHAR_MAP = {
    "\uff09": ")",
    "\uff08": "(",
    "\uff0c": ",",
    "\u3002": ".",
    "\u201c": '"',
    "\u201d": '"',
    "\u2018": "'",
    "\u2019": "'",
    "\uff1b": ";",
    "\u2014": "-",
    "\uff1a": ":",
    "\u3001": ",",
    "\u2192": "->",
    "\u3011": "]",
    "\u3010": "[",
    "\u2026": "...",
    "\uff1f": "?",
    "\uff01": "!",
}

# 编译正则 按匹配长度降序排序,避免 "\u201c" 和 "\u201d" 冲突,不过这里长度都一样
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
