#!/usr/bin/env bash
# `visual-budget` 的**浏览器级**回归夹具。
#
# 为什么与 visual-budget.test.py 分开：那份测的是纯函数（parse_ready / is_difference /
# outlier_of / unwrap / load_answers），够不到真正做判定的那段——它是一大串跑在页面里的 JS。
# 三轮外部复核判出的 HIGH **全部**落在那段 JS 或 main() 的入口校验上，而当时纯函数矩阵全绿。
# **矩阵全绿 ≠ 判定正确**，这份夹具补的就是这个缺口。
#
# 跑法：bash ~/.claude/bin/visual-budget.fixtures.sh    （需要 agent-browser 可用）
#
# **每条都要真正命中它宣称的那个分支。** 第一版栽在这里：拿
# `<span class=badge><span>OK</span></span>` 当"包装去重仍在"的阳性对照，而内层 span 没有
# paint / radius、根本进不了 badgeLike，那条对照在修对与修坏两种情况下都输出 60 ——
# 它什么都没测（外部复核指出）。所以下面凡标「阳性」的，都构造成**改坏就会变红**。

set -uo pipefail
VB="$(dirname "$0")/visual-budget"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAIL=0 RAN=0

pad() { for i in $(seq 1 30); do printf '<p>正文 %s。</p>' "$i"; done; }
PILL='style="border-radius:99px;border:1px solid red;padding:2px 6px;display:inline-block"'

want() { # want <名字> <实得> <期望>
  RAN=$((RAN+1))
  if [ "$2" = "$3" ]; then printf '  %-46s ✓ %s\n' "$1" "$2"
  else printf '  %-46s ✗ 得 %s 期望 %s\n' "$1" "$2" "$3"; FAIL=$((FAIL+1)); fi
}
reading() { "$VB" "file://$1" --ready '.c>=1' 2>&1 | grep "$2" | awk '{print $2}'; }
code() { "$VB" "file://$1" --ready '.c>=1' "${@:2}" >/dev/null 2>&1; echo $?; }

# ============================== 徽章计数与包装去重 ==============================
{ printf '<!doctype html><body><div class=c>x</div>'; pad
  for i in $(seq 1 60); do printf '<span %s>OK</span>' "$PILL"; done
  printf '</body>'; } > "$TMP/plain.html"

# **真正的包装**：外层与内层都满足 badgeLike，且外层只多出 2px padding（面积比 ≈1.2×）。
# 这才命中 1.8× 那个分支；内层不带 paint/radius 的写法根本进不了 badgeLike。
{ printf '<!doctype html><body><div class=c>x</div>'; pad
  for i in $(seq 1 60); do
    printf '<span style="border-radius:99px;border:1px solid red;padding:1px;display:inline-block">'
    printf '<span %s>OK</span></span>' "$PILL"
  done
  printf '</body>'; } > "$TMP/wrapped.html"

# **容器而非包装**：外层自身也满足 badgeLike，但装着 20 个兄弟（面积比远大于 1.8×）。
{ printf '<!doctype html><body><div class=c>x</div>'; pad
  printf '<div style="display:inline-block;height:36px;width:400px;background:#333;border-radius:8px">'
  for i in $(seq 1 20); do printf '<span %s>P%s</span>' "$PILL" "$i"; done
  printf '</div></body>'; } > "$TMP/nested.html"

echo "== 徽章计数：包装型祖先去重，容器型祖先不去重 =="
want "plain 60 个 pill"                    "$(reading "$TMP/plain.html" repeated_elements)"   "60"
want "真包装（内外都是 badge，比 ≈1.2×）"  "$(reading "$TMP/wrapped.html" repeated_elements)" "60"
want "容器（比 ≫1.8×）不吞掉 20 个子项"    "$(reading "$TMP/nested.html" repeated_elements)"  "21"
# 阳性：把比例调到 1.0 以下，真包装就不再去重，读数翻倍——证明上面那条确实走了这个分支。
want "阳性·比例调至 0.5 后包装不再去重" \
  "$("$VB" "file://$TMP/wrapped.html" --ready '.c>=1' --wrap-area-ratio 0.5 2>&1 | grep repeated_elements | awk '{print $2}')" "120"

# ============================== 同名列的 x ==============================
{ printf '<!doctype html><body><div class=c>x</div>'; pad
  printf '<div style="display:flex;gap:20px">'
  for k in 1 2 3; do
    printf '<div class=card style="flex:1"><table><thead><tr><th>指标</th><th>A</th><th>B</th></tr></thead><tbody>'
    for r in 1 2 3; do printf '<tr><td>m%s</td><td>1</td><td>2</td></tr>' "$r"; done
    printf '</tbody></table></div>'
  done
  printf '</div></body>'; } > "$TMP/multicol.html"

# 纵向堆叠、首列宽各不相同 → 相对偏移不同（真缺陷）。**宽度差 1px**：精确宽度分组会把它们
# 拆成三个单样本组、被 `xs.length>=3` 过滤掉而漏报（外部复核指出），所以这条同时守着分桶。
{ printf '<!doctype html><body><div class=c>x</div>'; pad
  i=0
  for w in 短 中等长度的内容 非常非常非常非常长的一段内容; do
    printf '<div class=scroller style="width:%spx"><table style="width:100%%"><thead><tr><th>名</th><th>在哪</th><th>状态</th></tr></thead><tbody>' "$((900+i))"
    printf '<tr><td>%s</td><td>x</td><td>y</td></tr></tbody></table></div>' "$w"
    i=$((i+1))
  done
  printf '</body>'; } > "$TMP/stacked.html"

echo "== 同名列 x：量相对本表左缘；表宽按桶分组，不按精确值 =="
want "三列并排（阴性：不得报结构缺陷）"       "$(code "$TMP/multicol.html")" "0"
want "纵向堆叠、宽度差 1px（阳性：必须报）"   "$(code "$TMP/stacked.html")"  "6"

# ============================== 展开记号 ==============================
# 合法但**内容为空**的 chevron：用两条边框画三角，`[open]` 时旋转。按 content 判会误报。
{ printf '<!doctype html><head><style>'
  # display:flex 只加在 .a / .b 上。**不能设成全局** `summary{display:flex}`——那会连
  # `.e` 的原生三角一起杀掉，于是 `.e` 真的没有记号、被正确报出，而夹具却把 0/3 当期望，
  # 读起来像"代码误报"。第一版就是这么写的，错的是夹具不是代码。
  printf '.a>summary,.b>summary{display:flex}'
  printf '.a>summary::after{content:"";width:8px;height:8px;border-right:2px solid #999;border-bottom:2px solid #999;transform:rotate(-45deg)}'
  printf '.a[open]>summary::after{transform:rotate(45deg)}'
  printf '.b>summary>svg{transform:rotate(0deg)}.b[open]>summary>svg{transform:rotate(90deg)}'
  printf '</style></head><body><div class=c>x</div>'; pad
  printf '<details class=a><summary>空 content 的 chevron</summary><p>x</p></details>'
  printf '<details class=b><summary><svg width=10 height=10></svg>会旋转的 svg</summary><p>x</p></details>'
  printf '<details class=e><summary>原生 marker</summary><p>x</p></details>'
  printf '</body>'; } > "$TMP/marks.html"

# 反向：summary 里有个与展开**无关**的头像 svg，页面完全没有展开提示。只验"有图形"会放行。
{ printf '<!doctype html><head><style>summary{display:flex}</style></head><body><div class=c>x</div>'; pad
  for i in 1 2 3; do
    printf '<details><summary><svg width=16 height=16></svg>无关头像 %s</summary><p>x</p></details>' "$i"
  done
  printf '</body>'; } > "$TMP/fakemark.html"

marks() { "$VB" "file://$1" --ready '.c>=1' 2>&1 | grep '可展开元素缺记号' | awk '{print $2"/"$4}'; }
echo "== 展开记号：判据是「渲染随开合而变」，不是「有没有图形」 =="
want "空 content chevron / 旋转 svg / 原生"  "$(marks "$TMP/marks.html")"    "0/3"
want "阳性·与展开无关的头像 svg 必须报"      "$(marks "$TMP/fakemark.html")" "3/3"

# ============================== 阈值参数 ==============================
echo "== 阈值参数：非有限或非正数一律入口拒绝，不得静默关闸 =="
for bad in nan inf -1 0; do
  want "--outlier-multiple $bad" "$(code "$TMP/plain.html" --outlier-multiple "$bad")" "2"
done
want "--diff-threshold nan"   "$(code "$TMP/plain.html" --diff-threshold nan)"   "2"
want "--wrap-area-ratio nan"  "$(code "$TMP/plain.html" --wrap-area-ratio nan)"  "2"

# ============================== 参照页与 JSON ==============================
{ printf '<!doctype html><body><div class=c>x</div>'; pad; printf '<span %s>OK</span></body>' "$PILL"; } > "$TMP/ref.html"
echo "== 参照页就绪闸与 JSON 审计契约 =="
"$VB" "file://$TMP/plain.html" --ready '.c>=1' --reference "file://$TMP/ref.html" >/dev/null 2>&1
want "给了 --reference 却缺 --reference-ready" "$?" "2"
"$VB" "file://$TMP/plain.html" --ready '.c>=1' --reference "file://$TMP/ref.html" --reference-ready '.c>=1' >/dev/null 2>&1
want "阳性·两个都给时离群闸照常开火"           "$?" "1"
want "覆盖倍数后触发行印的是生效值而非默认 10" \
  "$("$VB" "file://$TMP/plain.html" --ready '.c>=1' --reference "file://$TMP/ref.html" --reference-ready '.c>=1' --outlier-multiple 3 2>&1 | grep -c '闸：≥3×')" "1"
want "JSON 带齐 caveat/premises/thresholds/answers" \
  "$("$VB" "file://$TMP/plain.html" --ready '.c>=1' --json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sum(k in d for k in ("caveat","premises","thresholds_uncalibrated","answers","differing")))')" "5"
want "JSON 的 thresholds 含 wrap_area_ratio" \
  "$("$VB" "file://$TMP/plain.html" --ready '.c>=1' --json 2>/dev/null | python3 -c 'import json,sys; print("wrap_area_ratio" in json.load(sys.stdin)["thresholds_uncalibrated"])')" "True"

echo
if [ "$FAIL" -eq 0 ]; then echo "✓ 夹具全部通过（$RAN 条运行时断言）"
else echo "✗ $FAIL / $RAN 条失败"; exit 1; fi
