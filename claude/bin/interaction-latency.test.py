#!/usr/bin/env python3
"""interaction-latency 的夹具矩阵。

每一条夹具对应一次**真实发生过的误判**。作用不是"覆盖率"，是：任何人再改那段量法，
都必须先让这几条继续绿。

来源分两批。**第一批**是这段量法以散文形态被 review 推翻的三次：

  ① 终点判据恒为真（"当前文档存在 FCP 条目"在点击前就已成立）→ `noop-link`
  ② 终点不锚目标节点（rAF 下一帧无条件触发）→ `delayed-swap`
  ③ MutationObserver 命中即算数 → `rerender-same-text` / `class-toggle-only`

**第二批**是本工具第一版被外部 review 推翻的八条 HIGH——上一版夹具**对它们全部
零覆盖**，因为所有 fixture 都是"nav 与单一文本 #main 同级、点了立刻换":

  ④ 路径先变、内容后到 → `route-first`（第一版把 pathname 拼进签名，约两帧就收工）
  ⑤ 中间态被当最终态 → `loading-first`
  ⑥ innerText 变了但用户看不见 → `hidden-target`
  ⑦ 整页导航把仪器连同 document 销毁 → `full-navigation`
  ⑧ 点击落在 overlay 上而非目标控件 → `overlay-eats-click`
  ⑨ `--max-ms` 只查 cold → `hot-only-slow`
  ⑩ 不跑阴性对照仍退出 0 → `exit-code-without-negative-control`
  ⑪ 数据形状异常以 exit 1 冒充"慢" → 纯 Python 那几条

跑法：`python3 ~/.claude/bin/interaction-latency.test.py`（需要 agent-browser 与本机 Chrome）
不带浏览器时只跑纯 Python 那几条，并在结尾显式报出哪些被跳过——**跳过不等于通过**。
"""

from __future__ import annotations

import argparse
import functools
import http.server
import importlib.machinery
import importlib.util
import json
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from unittest import mock

TOOL = Path(__file__).with_name("interaction-latency")

SHELL = """<!doctype html><meta charset=utf-8>
<style>
 body{{font:14px system-ui;margin:0}} a{{display:block;padding:8px;width:220px}}
 {extra_css}
</style>
<nav>
  <a id=noop href="#" aria-current=page>当前这一项</a>
  <a id=go href="#">切到另一项</a>
</nav>
<main id=main>原始内容：第一批条目</main>
{extra_html}
<script>
const main = document.getElementById('main');
document.getElementById('noop').addEventListener('click', e => e.preventDefault());
document.getElementById('go').addEventListener('click', e => {{ e.preventDefault(); {go} }});
{extra_js}
</script>
"""


def page(go: str, *, css: str = "", html: str = "", js: str = "") -> str:
    return SHELL.format(go=go, extra_css=css, extra_html=html, extra_js=js)


FINAL = "main.textContent = '换过的内容：第二批条目'"

FIXTURES = {
    "noop-link": page(""),
    "delayed-swap": page(f"setTimeout(() => {{ {FINAL}; }}, 800)"),
    "fast-swap": page(f"{FINAL}"),
    "rerender-same-text": page("main.textContent = '原始内容：第一批条目'"),
    "class-toggle-only": page("main.classList.toggle('x')"),
    # ④ 路径**立刻**变，内容 800 ms 后才到。把 pathname 拼进签名的版本约两帧就收工。
    "route-first": page(
        f"history.pushState({{}}, '', '/changed'); setTimeout(() => {{ {FINAL}; }}, 800)"
    ),
    # ⑤ 先 Loading… 再最终内容。"内容变了"在 Loading 那一刻就成立，且它能稳定很久。
    "loading-first": page(
        f"main.textContent = 'Loading…'; setTimeout(() => {{ {FINAL}; }}, 700)"
    ),
    # ⑥ 文本变了，但目标 opacity:0——用户什么也没看见。
    "hidden-target": page(FINAL, css="#main{opacity:0}"),
    # ⑦ 真导航：仪器随旧 document 销毁。
    "full-navigation": page("location.href = './landed.html'"),
    "landed": "<!doctype html><meta charset=utf-8><main id=main>换过的内容：第二批条目</main>",
    # ⑧ overlay 盖住链接：坐标点击落在 overlay 上，而 document 监听器照样记下 pointerdown。
    "overlay-eats-click": page(
        FINAL,
        css="#veil{position:fixed;inset:0;background:rgba(0,0,0,.01);z-index:9}",
        html="<div id=veil></div>",
    ),
    # ⑨ 第三次加载起才变慢。cold 先测 → 顺序是 cold(1) / 阴性(2) / hot(3)，
    #    于是只有 hot 慢。只查 cold 的版本会退出 0。
    "hot-only-slow": page(
        f"const n = +(sessionStorage.getItem('n')||0);"
        f"setTimeout(() => {{ {FINAL}; }}, n >= 3 ? 900 : 0)",
        js="sessionStorage.setItem('n', String(+(sessionStorage.getItem('n')||0) + 1));",
    ),
}


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):  # noqa: ANN002, ANN201
        pass


def serve(root: Path) -> tuple[http.server.ThreadingHTTPServer, int]:
    port = free_port()
    handler = functools.partial(QuietHandler, directory=str(root))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


def run_tool(url: str, *extra: str) -> tuple[int, dict]:
    cmd = [sys.executable, str(TOOL), url, "--click", "#go", "--target", "#main",
           "--timeout", "3", "--json", *extra]
    if not any(a in ("--noop-click", "--no-negative-control") for a in extra):
        cmd += ["--noop-click", "#noop"]
    if not any(a in ("--until-text", "--any-change") for a in extra):
        cmd += ["--until-text", "换过的内容"]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    try:
        return proc.returncode, json.loads(proc.stdout)
    except json.JSONDecodeError:
        return proc.returncode, {"_out": proc.stdout[-300:], "_err": proc.stderr[-300:]}


def load_module():
    loader = importlib.machinery.SourceFileLoader("interaction_latency", str(TOOL))
    spec = importlib.util.spec_from_loader("interaction_latency", loader)
    assert spec is not None
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def python_cases(mod) -> list[tuple[str, bool, str]]:
    out: list[tuple[str, bool, str]] = []

    got = mod.unquote_eval('"{\\"a\\": 1}"')
    out.append(("双层编码的 eval 输出解成 dict", got == {"a": 1}, repr(got)))
    out.append(("单层 JSON 也能解", mod.unquote_eval('{"a": 2}') == {"a": 2}, ""))

    # ⑪ `null` / 布尔 / 数组都能无错通过 json.loads。放行它们，下游就会抛
    #    KeyError/TypeError，而 Python 的默认退出码 1 在本工具契约里是"页面慢"。
    for payload, why in [("null", "null"), ("true", "布尔"), ("[1,2]", "数组")]:
        try:
            mod.as_dict(mod.unquote_eval(payload), "state")
            out.append((f"{why}必须被拒（否则会以 exit 1 冒充『慢』）", False, "被放行了"))
        except mod.InstrumentError:
            out.append((f"{why}必须被拒（否则会以 exit 1 冒充『慢』）", True, ""))

    for bad, why in [("", "空输出"), ("not json", "不可解析")]:
        try:
            mod.unquote_eval(bad)
            out.append((f"{why}必须抛 InstrumentError", False, "没抛"))
        except mod.InstrumentError:
            out.append((f"{why}必须抛 InstrumentError", True, ""))

    for value, why in [(float("nan"), "NaN"), (float("inf"), "inf"), (True, "布尔"), ("3", "字符串")]:
        try:
            mod.finite(value, "t0")
            out.append((f"{why} 不能当成有限数通过", False, "被放行了"))
        except mod.InstrumentError:
            out.append((f"{why} 不能当成有限数通过", True, ""))

    out.append(("EXIT 语义：1=慢 与 3=没量准 是不同的码",
                mod.EXIT_SLOW != mod.EXIT_UNRESOLVED and mod.EXIT_INSTRUMENT == 2, ""))

    # ⑧c 测 **Python 侧消费 `hit` 的那个分支**。⑧b 只测 JS 把 hit 记得对不对；
    # 实测把 `if state.get("hit") is False:` 改成 `if False:`，⑧b 仍然绿——
    # 一个守卫的两半要各自有用例，否则"覆盖"只覆盖了不出事的那一半。
    class _P(mod.Probe):
        def __init__(self, states):  # noqa: D107
            args = argparse.Namespace(target="#main", until_text="x", any_change=False, timeout=1)
            super().__init__("stub", "http://stub", args)
            self._states = list(states)

        def ab(self, *argv, timeout=120):  # noqa: ANN002, ANN003
            return subprocess.CompletedProcess(argv, 0, "", "")

        def evaluate(self, script):  # noqa: ANN001
            return self._states.pop(0)

    canned_ok = [{"installed": True}, {"w": 10, "h": 10}]
    for hit, why, should_raise in [
        (False, "hit=False 必须抛 InstrumentError（exit 2），不能继续给毫秒数", True),
        (True, "hit=True 时不因该分支报错", False),
    ]:
        # token 必须与 measure() 内部生成的一致（uuid4().hex[:12]，下面 patch 成 "t"*32）
        probe = _P(canned_ok + [{"token": "t" * 12, "hit": hit, "done": True,
                                 "t0": 1.0, "changed_at": 2.0, "painted_at": 3.0}])
        probe.key = "__k"
        try:
            # measure() 内部会生成新 token，与 canned 的 "t" 不符；固定住它。
            with mock.patch.object(mod.uuid, "uuid4", lambda: mock.Mock(hex="t" * 32)):
                probe.measure("#go")
            raised = False
        except mod.InstrumentError as exc:
            raised = "落在" in str(exc)
        except Exception as exc:  # noqa: BLE001
            raised = f"其它异常: {type(exc).__name__}"
        ok = (raised is True) if should_raise else (raised is False)
        out.append((f"⑧c {why}", ok, f"raised={raised}"))

    return out


def main() -> int:
    mod = load_module()
    results = python_cases(mod)
    skipped: list[str] = []

    if shutil.which("agent-browser") is None:
        skipped.append("全部浏览器夹具（agent-browser 未安装）")
    else:
        tmp = Path(tempfile.mkdtemp())
        for name, html in FIXTURES.items():
            (tmp / f"{name}.html").write_text(html, encoding="utf-8")
        httpd, port = serve(tmp)
        base = f"http://127.0.0.1:{port}"
        try:
            def case(name, why, url_name, expect, *extra):
                code, rep = run_tool(f"{base}/{url_name}.html", *extra)
                ok, detail = expect(code, rep)
                results.append((f"{name} {why}", ok, detail))


            case("①", "点了什么都不改 → 报『没到』，不报漂亮的毫秒数", "noop-link",
                 lambda c, r: (c == mod.EXIT_UNRESOLVED
                               and r.get("cold", {}).get("changed") is False,
                               f"exit={c} cold={r.get('cold')}"))
            case("②", "内容 800 ms 后才换 → 须 ≳700 ms，不是 ~16 ms", "delayed-swap",
                 lambda c, r: (c == mod.EXIT_OK and (r.get("cold", {}).get("ms") or 0) >= 700,
                               f"exit={c} ms={r.get('cold', {}).get('ms')}"))
            case("", "立刻换 → changed 且读数小（不是只认慢的）", "fast-swap",
                 lambda c, r: (c == mod.EXIT_OK and (r.get("cold", {}).get("ms") or 9e9) < 400,
                               f"exit={c} ms={r.get('cold', {}).get('ms')}"),
                 "--any-change")
            case("③a", "重渲染成同样的文字 → 须报『没到』", "rerender-same-text",
                 lambda c, r: (c == mod.EXIT_UNRESOLVED, f"exit={c}"), "--any-change")
            case("③b", "只切 class → 须报『没到』", "class-toggle-only",
                 lambda c, r: (c == mod.EXIT_UNRESOLVED, f"exit={c}"), "--any-change")
            case("④", "路径先变、内容 800 ms 后到 → 须 ≳700 ms（路径不参与终点）",
                 "route-first",
                 lambda c, r: (c == mod.EXIT_OK and (r.get("cold", {}).get("ms") or 0) >= 700,
                               f"exit={c} ms={r.get('cold', {}).get('ms')} "
                               f"path={r.get('cold', {}).get('path_at_finish')}"))
            # ④b 才是真正隔离"路径不参与终点"的那一条。④ 带着 --until-text 跑，
            # 而 until-text 会把路径 bug 一并挡住——实测：把 pathname 拼回签名后
            # ④ 仍然全绿，只有这一条变红。夹具必须隔离它要测的那件事。
            case("④b", "同一页用 --any-change → 路径变化不得单独构成到达（≳700 ms）",
                 "route-first",
                 lambda c, r: (c == mod.EXIT_OK and (r.get("cold", {}).get("ms") or 0) >= 700,
                               f"exit={c} ms={r.get('cold', {}).get('ms')}"),
                 "--any-change")
            case("⑤", "先 Loading… 后最终内容 → 须量到最终态（≳600 ms）", "loading-first",
                 lambda c, r: (c == mod.EXIT_OK and (r.get("cold", {}).get("ms") or 0) >= 600,
                               f"exit={c} ms={r.get('cold', {}).get('ms')}"))
            case("⑤b", "同一页用 --any-change → 会量到 Loading 中间态（<400 ms），"
                 "这是该开关的已知代价、必须看得见", "loading-first",
                 lambda c, r: (c == mod.EXIT_OK and (r.get("cold", {}).get("ms") or 9e9) < 400,
                               f"exit={c} ms={r.get('cold', {}).get('ms')}"),
                 "--any-change")
            case("⑥", "文本变了但目标 opacity:0 → 用户没看见，须报『没到』", "hidden-target",
                 lambda c, r: (c == mod.EXIT_UNRESOLVED, f"exit={c} cold={r.get('cold')}"))
            case("⑦", "整页导航 → 须报 unsupported_full_navigation，不空等到超时",
                 "full-navigation",
                 lambda c, r: (c == mod.EXIT_UNRESOLVED
                               and r.get("cold", {}).get("reason") == "unsupported_full_navigation",
                               f"exit={c} cold={r.get('cold')}"))
            case("⑧", "overlay 盖住链接 → 点击没落在目标上，须 exit 2 而不是给个毫秒数",
                 "overlay-eats-click",
                 lambda c, r: (c == mod.EXIT_INSTRUMENT, f"exit={c} {r.get('_err', '')[:120]}"))
            case("⑨", "只有 hot 慢 → --max-ms 必须也查 hot", "hot-only-slow",
                 lambda c, r: (c == mod.EXIT_SLOW and "hot" in (r.get("over_max_ms") or []),
                               f"exit={c} over={r.get('over_max_ms')} "
                               f"cold={r.get('cold', {}).get('ms')} hot={r.get('hot', {}).get('ms')}"),
                 "--max-ms", "400")
            case("⑩", "不跑阴性对照 → 退出码固定 3，绝不伪装成 0", "delayed-swap",
                 lambda c, r: (c == mod.EXIT_UNRESOLVED
                               and str(r.get("negative_control", "")).startswith("未跑"),
                               f"exit={c} neg={r.get('negative_control')}"),
                 "--no-negative-control")

            # ⑧b 直接测 composedPath 那条守卫本身。
            # ⑧ 那条测不到它：本机 agent-browser 0.27.0 **自己就拒绝**被遮挡的点击
            # （实测 stderr 是 `click '#go' 失败`），于是退出码 2 来自另一条路径——
            # 去掉命中校验后 ⑧ 仍然绿。守卫不能靠一条它没参与的用例来"覆盖"。
            import uuid as _uuid
            sess = "iltest-" + _uuid.uuid4().hex[:8]

            def ab(*argv):
                return subprocess.run(["agent-browser", "--session", sess, *argv],
                                      capture_output=True, text=True, timeout=90)

            def hit_after_pointerdown_on(sel: str):
                ab("open", f"{base}/fast-swap.html")
                script = (mod.INSTALL
                          .replace("KEY", json.dumps("__il_probe"))
                          .replace("TARGET_SEL", json.dumps("#main"))
                          .replace("CLICK_SEL", json.dumps("#go"))
                          .replace("UNTIL_TEXT", json.dumps(""))
                          .replace("ANY_CHANGE", "true")
                          .replace("TOKEN", json.dumps("tok")))
                ab("eval", script)
                ab("eval", "document.querySelector(%s).dispatchEvent("
                           "new PointerEvent('pointerdown', {bubbles: true, composed: true}))"
                           % json.dumps(sel))
                raw = ab("eval", "JSON.stringify(window.__il_probe)").stdout
                return mod.as_dict(mod.unquote_eval(raw), "probe").get("hit")

            try:
                hit_wrong = hit_after_pointerdown_on("#noop")
                hit_right = hit_after_pointerdown_on("#go")
            finally:
                ab("close")
            results.append((
                "⑧b pointerdown 落在别的控件上 → hit 必须为 false（落在目标上则为 true）",
                hit_wrong is False and hit_right is True,
                f"wrong={hit_wrong} right={hit_right}",
            ))

            code, _ = run_tool(f"{base}/delayed-swap.html", "--max-ms", "10")
            results.append(("⑨b 超阈值 → exit 1（与 3 分开：慢 ≠ 没量准）",
                            code == mod.EXIT_SLOW, f"exit={code}"))

            proc = subprocess.run(
                [sys.executable, str(TOOL), f"{base}/delayed-swap.html", "--click", "#go"],
                capture_output=True, text=True, timeout=60)
            results.append(("既不给 --until-text 也不给 --any-change → argparse 拒绝",
                            proc.returncode != 0 and "until-text" in proc.stderr,
                            f"rc={proc.returncode}"))
        finally:
            httpd.shutdown()

    width = max(len(n) for n, _, _ in results)
    failed = sum(0 if ok else 1 for _, ok, _ in results)
    for name, ok, detail in results:
        print(f"  {'✓' if ok else '✗'} {name.ljust(width)}  {'' if ok else detail}")
    print()
    if skipped:
        print("跳过（**跳过不等于通过**）：")
        for s in skipped:
            print(f"  · {s}")
    print(f"{len(results) - failed}/{len(results)} 通过" + ("" if not failed else f"，{failed} 失败"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
