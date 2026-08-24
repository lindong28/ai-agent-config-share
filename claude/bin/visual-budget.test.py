#!/usr/bin/env python3
"""`visual-budget` 的夹具矩阵。**每条用例都是一次真实误判或一个真实设计缺陷的固化。**

跑法：`python3 ~/.claude/bin/visual-budget.test.py`

为什么要有它：本工具存在的全部理由，是"同一段量法被散文写错过四次"这条既有教训
（`web-ui-observation.md:46`）。而本工具自己的判定逻辑——什么算差异、什么算离群、
就绪闸怎么解析、eval 结果怎么拆——同样是会被写错的东西，而且**写错时的输出与写对时同形**
（一个恒不触发的离群闸，读起来和"这个页面很干净"一模一样）。
"""
import importlib.machinery, importlib.util, pathlib, sys, tempfile

# 被测文件没有 .py 后缀（它是 bin/ 下的可执行程序），所以用显式 loader 而不是普通 import。
_p = pathlib.Path(__file__).with_name("visual-budget")
_loader = importlib.machinery.SourceFileLoader("visual_budget", str(_p))
_spec = importlib.util.spec_from_loader("visual_budget", _loader)
assert _spec is not None
vb = importlib.util.module_from_spec(_spec)
_loader.exec_module(vb)

FAIL = []


def check(name, got, want):
    if got != want:
        FAIL.append(f"{name}: got {got!r}, want {want!r}")


# ---------------------------------------------------------------- parse_ready
# 就绪闸是本工具唯一挡住"未渲染页读成极其克制的设计"的东西。解析错 = 闸不存在。
def raises(fn, *a):
    try:
        fn(*a)
    except ValueError:
        return True
    except Exception:
        return False
    return False


check("ready: 带阈值", vb.parse_ready(".card>=3"), (".card", 3))
check("ready: 不带阈值默认 1", vb.parse_ready(".card"), (".card", 1))
check("ready: None（此时 main 会要求显式 --no-ready-gate）", vb.parse_ready(None), (None, 1))
# 属性选择器里带 >= 的形态：不能被阈值正则吃掉
check("ready: 属性选择器不被截断", vb.parse_ready('[data-n]>=2'), ('[data-n]', 2))
# 阈值 0 让闸恒真——外部评审实测 `>=0` 与 `.definitely-missing>=0` 都能把它整个绕过。
check("ready: 阈值 0 必须报错（否则闸恒真）", raises(vb.parse_ready, ".card>=0"), True)
check("ready: 只给阈值、没有 selector 必须报错", raises(vb.parse_ready, ">=2"), True)
check("ready: 空串必须报错（不得变成匹配一切的空选择器）", raises(vb.parse_ready, "   "), True)

# --------------------------------------------------------------- is_difference
# 差异判据决定"哪些项必须作答"。判宽了每次都要写一堆废话，判窄了真差异静默放过。
check("diff: 25% 以内不算", vb.is_difference(120, 100), False)
check("diff: 超过 25% 算", vb.is_difference(126, 100), True)
check("diff: 反向同样算", vb.is_difference(70, 100), True)
# 分母为 0 是本函数最容易写错的一格：`abs(a-b)/b` 会 ZeroDivisionError，
# 而用 `max(b,1e-9)` 兜底则会把 0→0 也判成差异。
check("diff: 参照为 0、本页为 0 → 不算差异", vb.is_difference(0, 0), False)
check("diff: 参照为 0、本页非 0 → 算差异", vb.is_difference(3, 0), True)
# 缺读数不是差异，是"没量到"——两者混同会让未测项伪装成已通过的项。
check("diff: 本页缺读数 → 不算差异（不是通过，是没量）", vb.is_difference(None, 100), False)
check("diff: 参照缺读数 → 不算差异", vb.is_difference(100, None), False)

# ----------------------------------------------------------------- outlier_of
# 离群闸是唯一的判定。它有两条前提，少任何一条都会让它变成噪声或变成摆设。
check("outlier: 1767 vs 11 触发（真实的那次）", vb.outlier_of(1767, 11), (1767, 11))
check("outlier: 17 vs 11 不触发（修好之后的那次）", vb.outlier_of(17, 11), None)
# 绝对下限 50：没有它，参照 1 个、本页 12 个就报 12× 离群，而好页面实测区间是 0–48。
check("outlier: 12 vs 1 = 12× 但低于绝对下限 50 → 不触发", vb.outlier_of(12, 1), None)
check("outlier: 60 vs 1 = 60× 且过下限 → 触发", vb.outlier_of(60, 1), (60, 1))
# 参照为 0 时 `mine >= ref * 10` 恒真——必须靠 max(1, ref) 与下限一起兜住。
check("outlier: 参照 0、本页 3 → 不触发（否则参照一为 0 就恒报）", vb.outlier_of(3, 0), None)
check("outlier: 参照 0、本页 500 → 触发", vb.outlier_of(500, 0), (500, 0))
check("outlier: 缺读数不触发", vb.outlier_of(None, 11), None)
check("outlier: 恰好 10× 且过下限 → 触发（闸是 ≥ 不是 >）", vb.outlier_of(100, 10), (100, 10))
# 两个常数可覆盖，且覆盖后判定要随之改变——否则"可调"是假的。
check("outlier: 降低下限后 12 vs 1 触发", vb.outlier_of(12, 1, floor=10), (12, 1))
check("outlier: 提高倍数后 1767 vs 11 不再触发", vb.outlier_of(1767, 11, multiple=200), None)
# 外部评审算出的三个已知断点，钉死在这里：改常数时它们会一起变红，逼人重新想一遍。
check("outlier 断点·漏报：参照 4、本页 49（12×）卡在下限", vb.outlier_of(49, 4), None)
check("outlier 断点·误报：参照 5、本页 50 触发（50 只比正例上沿 48 多 2）", vb.outlier_of(50, 5), (50, 5))
check("outlier 断点·漏报：参照 20、本页 199（近 10×）不触发", vb.outlier_of(199, 20), None)

# 差异阈值同样可覆盖
check("diff: 阈值可覆盖——120 vs 100 在 0.1 下算差异", vb.is_difference(120, 100, 0.1), True)
check("diff: 默认 0.25 下 120 vs 100 不算（正文一度声称无阈值，实为有）",
      vb.is_difference(120, 100), False)

# -------------------------------------------------------------------- unwrap
# agent-browser 把 eval 结果作为**带引号的 JSON 字符串**回显。少剥一层就永远拿不到读数，
# 而拿不到读数走的是 EXIT_INSTRUMENT——不会静默变成"页面很干净"，但会让工具无法使用。
check("unwrap: 双层引号", vb.unwrap('"{\\"a\\": 1}"'), {"a": 1})
check("unwrap: 单层 JSON", vb.unwrap('{"a": 1}'), {"a": 1})
check("unwrap: 前面有噪声行时取最后一行", vb.unwrap('shell helper 未加载\n"{\\"a\\": 1}"'), {"a": 1})
check("unwrap: 空输出 → None（不是空 dict）", vb.unwrap(""), None)
check("unwrap: 非 JSON → None", vb.unwrap("Evaluation error: SyntaxError"), None)
check("unwrap: JSON 但不是对象 → None", vb.unwrap('"[1,2]"'), None)

# ------------------------------------------------------------- load_answers
with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as fh:
    fh.write("# 注释行\n\nscreens: 这一页是 15 个 case 的全量核对台，参照只有 8 条记录\n"
             "hue_buckets:   \n"          # 冒号后为空 = 没作答
             "borders_per_100: 表格行的下边框，参照页没有表格\n"
             "没有冒号的行\n")
    answers_path = fh.name
ans = vb.load_answers(answers_path)
check("answers: 正常条目", ans.get("screens"), "这一页是 15 个 case 的全量核对台，参照只有 8 条记录")
check("answers: 冒号后为空**不算作答**（否则写个冒号就能过闸）", "hue_buckets" in ans, False)
check("answers: 注释与无冒号行被跳过", len(ans), 2)
check("answers: 不给文件 → 空", vb.load_answers(None), {})

# ------------------------------------------- L1b：三条不需要标定的结构读数
# 它们与上面的用量读数**性质不同**：由构造给出，不需要参照也不需要语料。
# 混进同一个退出码，弱的那个（未标定的离群闸）会借走强的那个的信用。
check("EXIT_STRUCTURAL 与 EXIT_OUTLIER 不同码", vb.EXIT_STRUCTURAL != vb.EXIT_OUTLIER, True)
check("EXIT_STRUCTURAL 与其余四码都不同",
      len({vb.EXIT_OK, vb.EXIT_OUTLIER, vb.EXIT_INSTRUMENT, vb.EXIT_UNRESOLVED,
           vb.EXIT_INCOMPLETE, vb.EXIT_STRUCTURAL}), 6)

# ------------------------------------------------------------------ 退出码
# 把"页面有问题"(1) 与"我没量准"(3) 混成一个码，两种结局就同形了——本工具存在的理由正是不让它们同形。
check("exit codes 互不相同", len({vb.EXIT_OK, vb.EXIT_OUTLIER, vb.EXIT_INSTRUMENT,
                                  vb.EXIT_UNRESOLVED, vb.EXIT_INCOMPLETE}), 5)
check("EXIT_OK 是 0", vb.EXIT_OK, 0)

# ------------------------------------------------- REPORT_ONLY 不得含进闸的量
# 若 repeated_elements 混进只报读数列表，唯一的判定就静默消失了，而输出看起来完全正常。
check("repeated_elements 不在只报读数列表里", "repeated_elements" in vb.REPORT_ONLY, False)
check("只报读数列表非空（否则等于所有项都在判定）", len(vb.REPORT_ONLY) > 0, True)

if FAIL:
    print(f"✗ {len(FAIL)} 条失败：")
    for f in FAIL:
        print("   " + f)
    sys.exit(1)
print("✓ 全部通过")
