#!/usr/bin/env bash
# 跑齐 hooks/ 下所有 *.test.js 与跨目录的标准回归套件，一条失败即整体失败。
#
# 为什么需要这个入口：这些测试写得不错，但此前**没有任何东西会执行它们**——
# package.json 的 test 脚本是 `exit 1`，也没有 CI。一个从不被执行的测试，与不存在
# 的区别只在于它让人**以为**有防线，而那比没有防线更糟：下一个人会因为"有测试"
# 而跳过手工验证。
#
# 逐个子进程跑而不是 require 进同一个进程：每份测试都 spawn 真 hook 并断言退出码，
# 共享进程会让某一份里的 process.env 改动泄漏给下一份。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
pass=0; fail=0; skip=0; failed=(); skipped=()
# 递归枚举，而不是单层 `*.test.js`：子目录里的测试曾因 runner 只看当前目录而完全漏跑。
# 单层 glob 的失败形态是**静默**：新建一个子目录就少一片覆盖，输出里什么都不会说。
# 枚举 hooks/ 与 bin/ 两棵树。`claude/bin/autopilot.test.js` 落在 hooks/ 之外，
# 于是它写好、能跑、却从不被套件执行——与本文件上次修的漏覆盖同类，只是漏的是同级目录。
#
# 为什么不干脆把根提到 `claude/`：那样会吞进 `plugins/marketplaces/` 下的第三方插件
# （实测一次 226 份 / 33 失败），它们不是本仓维护的代码，红了也不该由这里的读数承担——
# 一个恒红的套件训练出来的行为就是无视它。覆盖面要跟着**本仓拥有的代码**走，不是跟着目录树走。
tests=()
while IFS= read -r test_file; do
  tests+=("$test_file")
done < <(find . ../bin -name '*.test.js' -not -path '*/node_modules/*' 2>/dev/null | sort)
if [ "${#tests[@]}" -eq 0 ]; then
  # 空集合与"全部通过"在下面的计数里同形，必须在这里就分开。
  printf 'no test files found under %s — runner is broken, not green\n' "$PWD" >&2
  exit 1
fi
explicit_tests=(
  ../scripts/hooks/post-compact-restore.program.test.js
  ../../codex/bin/gen-agents-skills.denylist.test.js
  ../../codex/bin/codex-compaction-hooks.test.js
  ../../codex/bin/codex-hook-parity.test.js
)
python_tests=(
  ../scripts/test_mcp_dedup.py
)
for f in "${explicit_tests[@]}"; do
  if [ -e "$f" ]; then
    tests+=("$f")
  else
    fail=$((fail+1)); failed+=("$f")
    printf '\n=== FAIL %s ===\nmissing explicit test suite: %s\n' "$f" "$f"
  fi
done
for f in "${tests[@]}"; do
  # Only the unmatched *.test.js glob may be absent; explicit suites were checked above.
  [ -e "$f" ] || continue
  if out=$(node "$f" 2>&1); then
    pass=$((pass+1))
  elif printf '%s' "$out" | grep -q "judge_unavailable"; then
    # 判官（远端小模型）不可用时，走到它的那几份测试会以 judge_unavailable 失败。
    # 这**不是回归**，把它算进 fail 会让整个套件间歇性变红——而一个会随机报错的
    # 套件，训练出来的行为正是"忽略它"，那与没有套件等价。实测判官不可用率约 4.4%
    # （77/1759 条裁决），所以这不是罕见路径。
    # 单列而不是静默跳过：跳过会让"判官挂了"与"这几份测试全绿"在输出里同形。
    skip=$((skip+1)); skipped+=("$f")
  else
    fail=$((fail+1)); failed+=("$f")
    printf '\n=== FAIL %s ===\n%s\n' "$f" "$out"
  fi
done
for f in "${python_tests[@]}"; do
  if [ ! -e "$f" ]; then
    fail=$((fail+1)); failed+=("$f")
    printf '\n=== FAIL %s ===\nmissing explicit test suite: %s\n' "$f" "$f"
  elif out=$(python3 "$f" 2>&1); then
    pass=$((pass+1))
  else
    fail=$((fail+1)); failed+=("$f")
    printf '\n=== FAIL %s ===\n%s\n' "$f" "$out"
  fi
done
printf '\nhooks 测试：%d 通过，%d 失败，%d 判官不可用（共 %d 份）\n' \
  "$pass" "$fail" "$skip" "$((pass+fail+skip))"
if [ "$skip" -gt 0 ]; then
  printf '判官不可用（非回归，这几份的判官分支本轮未验证）：%s\n' "${skipped[*]}"
fi
if [ "$fail" -gt 0 ]; then
  printf '失败清单：%s\n' "${failed[*]}"
  exit 1
fi
