#!/usr/bin/env python3
"""page-repetition 的守卫。

这件仪器存在的全部理由是「读一遍」找不到重复，所以它自己**必须报得出相反的结局**——
一个恒报"没有重复"的探针与一个恒报"很重复"的探针，在被信任这一点上一样坏。
每条断言因此成对：给它一份重复的文本、再给一份不重复的，读数必须不同。

最要紧的一条是最后那组：**正文为空一律是仪器故障，不是"没有重复"**。
读不到内容时任何计数都得零，而零看起来像很干净——本探针防的正是这种同形。
"""

import importlib.machinery
import importlib.util
import json
import pathlib
import subprocess
import sys
import unittest

PROBE = pathlib.Path(__file__).with_name("page-repetition")

# 探针没有 .py 后缀（它是 bin 里的可执行文件），所以按显式 loader 载入，不走 import 名。
_loader = importlib.machinery.SourceFileLoader("page_repetition", str(PROBE))
_spec = importlib.util.spec_from_loader("page_repetition", _loader)
assert _spec is not None, f"无法为 {PROBE} 构造 module spec"
mod = importlib.util.module_from_spec(_spec)
_loader.exec_module(mod)


REPEATED = "\n".join(["这张表里没有一个数经过人评校准，阈值也没有在留出集上校准。"] * 14
                     + ["身份连续性 cosine", "0.4451", "0.4220"])
CLEAN = "\n".join([f"第 {i} 条各不相同的说明文字，长度足够进入统计。" for i in range(14)])


def stats_for(text, min_chars=12):
    lines, sents, _ = mod.units_of(text, min_chars)
    return mod.tally(lines, len(text)), mod.tally(sents, len(text))


class Counting(unittest.TestCase):
    def test_repeated_and_clean_do_not_read_the_same(self):
        rep_l, rep_s = stats_for(REPEATED)
        clean_l, clean_s = stats_for(CLEAN)
        self.assertEqual(rep_l["worst"], 14)
        self.assertEqual(clean_l["worst"], 1)
        self.assertEqual(clean_s["worst"], 1, "干净文本在句粒度上也不得误报")
        self.assertGreater(rep_s["share_of_counted"], 0.5)
        self.assertEqual(clean_s["redundant_chars"], 0)

    def test_unique_prefix_does_not_hide_a_repeated_sentence(self):
        # 评审给的反例：每行带唯一序号、后接同一句免责。**整行粒度完全看不见它**——
        # 这正是"只认整行"会让仪器宣称的比它量的多。子句粒度必须抓到。
        text = "\n".join(f"第 {i} 条：这一轨没有一个自动指标经过人评校准，不得据此比较。"
                        for i in range(20))
        by_line, by_sent = stats_for(text)
        self.assertEqual(by_line["worst"], 1, "整行粒度确实看不见（记录这个已知局限）")
        self.assertEqual(by_sent["worst"], 20, "子句粒度必须抓到 20 次")
        self.assertGreater(by_sent["share_of_counted"], 0.8)

    def test_short_units_do_not_drown_the_signal(self):
        # 表头、模型名、按钮文案本来就该重复。把它们计进来，真问题会被淹没。
        text = "\n".join(["v1", "v2", "—"] * 30 + ["一句足够长的、只出现一次的说明文字。"])
        tight, _ = stats_for(text, 12)
        self.assertEqual(tight["redundant_chars"], 0, "短单元不该计入冗余")
        loose, _ = stats_for(text, 1)
        self.assertGreater(loose["redundant_chars"], 0, "门槛调低后读数必须变")

    def test_first_occurrence_is_not_counted_as_redundant(self):
        # 读者问的是"我读到的字里有多少是我已经读过的"。把第一遍也算成冗余会系统性高估。
        one, _ = stats_for("同一句话被写了两遍，这是第一遍。\n同一句话被写了两遍，这是第一遍。")
        self.assertEqual(one["redundant_chars"], len("同一句话被写了两遍，这是第一遍。"))

    def test_share_numerator_and_denominator_share_one_yardstick(self):
        # 分子用归一化后的合格单元、分母用原始 innerText 时，比例既偏小又不可跨页比较。
        text = "\n".join(["同一句话重复出现，用来检查口径。"] * 4)
        by_line, _ = stats_for(text)
        self.assertAlmostEqual(by_line["share_of_counted"], 3 / 4, places=6)
        self.assertLessEqual(by_line["coverage_of_text"], 1.0)


class EmptyIsNotClean(unittest.TestCase):
    """正文为空必须是仪器故障。这是本探针最要紧的一条不变式。"""

    def test_counting_core_reports_zero_for_empty(self):
        # 计数核心确实会给零——所以"空"不能由它来判，必须由调用层拦掉。
        by_line, _ = stats_for("")
        self.assertEqual(by_line["redundant_chars"], 0)

    def test_non_empty_wrong_page_is_not_treated_as_clean(self):
        # 登录页 / 错误页的正文同样非空。不声明 --expect-text 时，输出必须把
        # "无法确认读到的是目标页面"写进未核实范围——否则 exit 0 会被读成通过。
        by_line, by_sent = stats_for("Sign in to continue")
        out, code = mod.render("u", {"text": "Sign in to continue"}, by_line, by_sent,
                               5, 12, False, None, expect_hit=None)
        self.assertEqual(code, 0)
        self.assertIn("没有声明 --expect-text", out)
        self.assertIn("未判定", out.splitlines()[0], "首行必须是未判定，不是通过")

    def test_cli_treats_unreadable_page_as_instrument_failure(self):
        # about:blank 能打开、能 eval，但正文为空——正是"读不到内容"的最干净复现。
        proc = subprocess.run([sys.executable, str(PROBE), "about:blank"],
                              capture_output=True, text=True, timeout=180)
        self.assertEqual(proc.returncode, 2,
                         f"空正文必须退出 2（仪器故障），实际 {proc.returncode}\n{proc.stderr}")
        self.assertIn("正文为空", proc.stderr)
        self.assertNotIn("没有重复", proc.stdout, "绝不能把读不到报成没有重复")


class DeclaredLimit(unittest.TestCase):
    PAGE = {"collapsed": 0, "detailsTotal": 0, "text": REPEATED}

    def test_max_repeat_flips_the_exit_code_both_ways(self):
        l, s = stats_for(REPEATED)
        _, over = mod.render("u", self.PAGE, l, s, 5, 12, False, 5, True)
        _, under = mod.render("u", self.PAGE, l, s, 5, 12, False, 20, True)
        self.assertEqual((over, under), (1, 0), "声明的上限必须两个方向都能翻转退出码")

    def test_undecided_is_not_pass(self):
        l, s = stats_for(REPEATED)
        out, code = mod.render("u", self.PAGE, l, s, 5, 12, False, None, True)
        self.assertEqual(code, 0)
        self.assertIn("未判定", out.splitlines()[0])
        self.assertNotIn("通过", out.splitlines()[0], "未判定不得读成通过")

    def test_max_repeat_zero_is_rejected_rather_than_silently_diverging(self):
        proc = subprocess.run([sys.executable, str(PROBE), "about:blank", "--max-repeat", "0"],
                              capture_output=True, text=True, timeout=120)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("至少为 1", proc.stderr)


class UnreadRangeStaysVisible(unittest.TestCase):
    def test_collapsed_details_are_reported_as_unread_not_folded_into_the_share(self):
        # 把"没读到"塌进"健康"正是本探针要防的形状，所以它必须单列。
        l, s = stats_for(CLEAN)
        page = {"collapsed": 58, "detailsTotal": 72, "text": CLEAN}
        out, _ = mod.render("u", page, l, s, 5, 12, False, None, True)
        self.assertIn("未读到 / 未核实的范围", out)
        self.assertIn("58 个折叠区未展开", out)
        expanded, _ = mod.render("u", page, l, s, 5, 12, True, None, True)
        self.assertIn("· 无", expanded, "展开且已确认目标后就不该再报为未核实")

    def test_iframes_are_declared_as_unread(self):
        l, s = stats_for(CLEAN)
        out, _ = mod.render("u", {"collapsed": 0, "detailsTotal": 0, "frames": 3, "text": CLEAN},
                            l, s, 5, 12, True, None, True)
        self.assertIn("3 个 iframe", out, "只读主文档这件事必须说出来")

    def test_conclusion_is_on_the_first_line(self):
        # 读者跑这条命令是为了回答"要不要动手"，不该读完明细才在末行看到结论。
        l, s = stats_for(REPEATED)
        out, _ = mod.render("u", {"collapsed": 0, "detailsTotal": 0, "text": REPEATED},
                            l, s, 5, 12, False, None, True)
        self.assertRegex(out.splitlines()[0], r"^(未判定|超限|通过) · 最多重复 \d+ 次")




class TargetIdentityGatesTheVerdict(unittest.TestCase):
    """本探针存在的理由就是分出目标页与登录页——裁决里必须体现，否则等于没做。"""

    def test_declared_limit_without_identity_is_never_pass(self):
        # 评审实测的漏口：声明了 --max-repeat、没声明 --expect-text 时，登录页也报"通过"。
        l, s = stats_for(CLEAN)
        page = {"collapsed": 0, "detailsTotal": 0, "text": CLEAN}
        out, code = mod.render("u", page, l, s, 5, 12, True, max_repeat=99, expect_hit=None)
        self.assertEqual(code, 0)
        self.assertIn("未判定", out.splitlines()[0])
        self.assertNotIn("通过", out.splitlines()[0])
        self.assertIn("没有确认读到的是目标页面", out)
        # 确认了身份才允许报通过——两个方向都要能翻转，否则这条断言没有区分力。
        ok, _ = mod.render("u", page, l, s, 5, 12, True, max_repeat=99, expect_hit=True)
        self.assertIn("通过", ok.splitlines()[0])

    def test_blank_expect_text_is_rejected(self):
        # 空标记命中任何正文，等于把身份确认悄悄关掉——shell 变量为空时最常撞。
        proc = subprocess.run([sys.executable, str(PROBE), "about:blank", "--expect-text", ""],
                              capture_output=True, text=True, timeout=120)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("不能是空串", proc.stderr)


class FirstLineIsOneYardstick(unittest.TestCase):
    def test_worst_and_share_do_not_come_from_different_granularities(self):
        # 评审的反例：10 条完全相同的长行，其**子句都短于门槛** → 只报子句占比会得到
        # "最多重复 10 次 · 0.0%"，一个自相矛盾的首行。
        # 无标点的长串不构成这个反例——它不会被切，两个粒度必然相同（我的第一版前提就错在这）。
        text = "\n".join(["甲甲，乙乙，丙丙，丁丁，戊戊，己己。"] * 10)
        l, s = stats_for(text)
        out, _ = mod.render("u", {"collapsed": 0, "detailsTotal": 0, "text": text},
                            l, s, 5, 12, True, None, True)
        head = out.splitlines()[0]
        # 断数字，不只断标签：只断言"标签在"时，实现退回单口径也可能照样通过。
        self.assertGreater(l["share_of_counted"], 0.8, "整行粒度确实有大量重复")
        self.assertEqual(s["share_of_counted"], 0.0, "而子句粒度在这份输入上是 0")
        self.assertIn(f"整行 {l['share_of_counted'] * 100:.1f}%", head)
        self.assertIn(f"子句 {s['share_of_counted'] * 100:.1f}%", head)


class Locatable(unittest.TestCase):
    def test_repeated_units_carry_a_first_line_number(self):
        # 动态拼接 / i18n 的文字在源码里 grep 不到；行号是能把人带到现场的最低成本定位。
        text = "前面一行足够长的无关文字，用来占位。\n" + "\n".join(["同一句免责重复出现，用于定位测试。"] * 3)
        lines, sents, first = mod.units_of(text, 12)
        self.assertEqual(first["同一句免责重复出现，用于定位测试。"], 2)
        l, s = mod.tally(lines, len(text)), mod.tally(sents, len(text))
        out, _ = mod.render("u", {"collapsed": 0, "detailsTotal": 0, "text": text},
                            l, s, 5, 12, True, None, True, first)
        self.assertIn("首现第 2 行", out)


    def test_unconfirmed_identity_cannot_report_over_either(self):
        # 只挡住"不能报通过"是不够的：读到的可能根本不是目标页面，把它的重复算成目标
        # "超限"同样是错的归因，而 exit 1 会让上游据此动手。
        l, s = stats_for(REPEATED)
        page = {"collapsed": 0, "detailsTotal": 0, "text": REPEATED}
        out, code = mod.render("u", page, l, s, 5, 12, True, max_repeat=2, expect_hit=None)
        self.assertEqual(code, 0, "身份未确认时不得退出 1")
        self.assertIn("未判定", out.splitlines()[0])
        self.assertNotIn("超限", out.splitlines()[0])
        # 确认身份后同一份输入必须变成超限——否则这条断言没有区分力。
        ok, ok_code = mod.render("u", page, l, s, 5, 12, True, max_repeat=2, expect_hit=True)
        self.assertEqual(ok_code, 1)
        self.assertIn("超限", ok.splitlines()[0])


class LineNumbersArePhysical(unittest.TestCase):
    def test_blank_lines_do_not_shift_the_reported_line(self):
        # `\n+` 会把连续空行并成一个分隔符，行号随空白段累积漂移，把人带到错的位置。
        text = "第一行是足够长的一段无关文字。\n\n\n实际首现在第四行的那句重复文字。"
        _, _, first = mod.units_of(text, 12)
        self.assertEqual(first["实际首现在第四行的那句重复文字。"], 4)


class OneVerdictForAllEntryPoints(unittest.TestCase):
    """人类输出、JSON 与退出码必须来自同一处裁决——两份会各自漂移。"""

    def test_verdict_table(self):
        for worst, cap, hit, want in [
            (56, 5, True, "over"), (56, 5, None, "undecided"),
            (2, 5, True, "pass"), (2, None, True, "undecided"),
            (56, 5, False, "undecided"),
        ]:
            self.assertEqual(mod.verdict(worst, cap, hit), want, f"{worst}/{cap}/{hit}")
        self.assertEqual(mod.EXIT_FOR, {"over": 1, "pass": 0, "undecided": 0})

    def _run_main(self, argv, text):
        """桩住浏览器，真的走一遍 main()。

        只统计源码里的字符串（`EXIT_FOR[status]` 出现两次之类）挡不住漂移：以后新增一份
        `json_status = …` 并用于输出、同时保留那两处，形状断言仍会全过。要挡住它，
        必须从**入口的行为**上断言。
        """
        import contextlib, io
        page = {"text": text, "collapsed": 0, "detailsTotal": 0,
                "frames": 0, "href": "u", "converged": True}
        orig_collect, orig_which, orig_run = mod.collect, mod.shutil.which, mod.run
        mod.collect = lambda *a, **k: page
        mod.shutil.which = lambda _n: "/bin/true"
        mod.run = lambda *a, **k: subprocess.CompletedProcess(a[0], 0, "", "")
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                code = mod.main(argv)
        finally:
            mod.collect, mod.shutil.which, mod.run = orig_collect, orig_which, orig_run
        return code, buf.getvalue()

    def test_json_entry_point_honours_the_identity_gate(self):
        # 未确认身份 + 本会超限：JSON 路径必须 undecided / exit 0，而不是 over / exit 1。
        code, out = self._run_main(["u", "--max-repeat", "2", "--json"], REPEATED)
        payload = json.loads(out)
        self.assertEqual((payload["status"], payload["target_confirmed"], code),
                         ("undecided", False, 0))

    def test_json_entry_point_reports_over_once_identity_is_confirmed(self):
        # 反方向：确认身份后同一份输入必须变成 over / exit 1，否则上一条没有区分力。
        code, out = self._run_main(
            ["u", "--max-repeat", "2", "--expect-text", "人评校准", "--json"], REPEATED)
        payload = json.loads(out)
        self.assertEqual((payload["status"], payload["target_confirmed"], code),
                         ("over", True, 1))


if __name__ == "__main__":
    unittest.main(verbosity=2)
