#!/usr/bin/env python3
"""first-screen-density 的夹具矩阵。

矩阵里的每一个夹具都对应一次**真实发生过的误判**——这段量法在成为程序之前，以散文形态
被独立实跑推翻过四次，每一次的反例都在这里固化成一条会红的用例。所以这个文件的作用不是
"覆盖率"，是：任何人再改那段量法，都必须先让这几条继续绿。

跑法：`python3 ~/.claude/bin/first-screen-density.test.py`（需要 agent-browser 与本机 Chrome）
"""

from __future__ import annotations

import http.server
import functools
import socket
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

TOOL = str(Path(__file__).with_name("first-screen-density"))

CSS = """
*{box-sizing:border-box;margin:0}
body{font:14px system-ui}
.card{height:110px;margin:0 0 6px;background:#dde;border:1px solid #99a;padding:8px}
"""

FIXTURES: dict[str, str] = {
    # 对照：正常 3 条，全部完整可见
    "normal": """<div class=list>
        <div class=card>1</div><div class=card>2</div><div class=card>3</div></div>""",

    # v1 杀手：祖先 overflow:hidden 整块裁掉。纯 rect 会全部放行
    "clip": """<div style="height:120px;overflow:hidden"><div class=list>
        <div class=card>1</div><div class=card>2</div><div class=card>3</div></div></div>""",

    # v2 杀手：IO v1 对这三种一律给 ratio 1.0
    "opacity": """<div class=list><div class=card>1</div>
        <div class=card style="opacity:0">2</div><div class=card>3</div></div>""",
    "hidden": """<div class=list><div class=card>1</div>
        <div class=card style="visibility:hidden">2</div><div class=card>3</div></div>""",
    "zero": """<div class=list><div class=card>1</div>
        <div class=card style="height:0;padding:0;border:0">2</div><div class=card>3</div></div>""",
    "covered": """<div style="position:fixed;top:0;left:0;right:0;height:130px;background:#333"></div>
        <div class=list><div class=card>1</div><div class=card>2</div><div class=card>3</div></div>""",

    # v4 杀手 ①：相邻卡片的投影压边，isVisible 判 false 而人眼看不出
    "shadow": """<div class=list>""" + "".join(
        '<div class=card style="margin:0;box-shadow:0 2px 8px rgba(0,0,0,.3)">%d</div>' % i
        for i in range(1, 5)) + "</div>",

    # v4 杀手 ②：fixed 头不进分母 → 一条永远读不完整的条目被判"装得下"
    "fixedhead": """<div style="position:fixed;top:0;left:0;right:0;height:90px;background:#333"></div>
        <div class=list style="padding-top:90px">
        <div class=card style="height:730px">tall</div></div>""",

    # v4 杀手 ③：列表整个在首屏之下 → band 面积 0，比值无定义
    "offscreen": """<div style="height:1400px"></div>
        <div class=scr style="height:300px;overflow:auto"><div class=list>
        <div class=card>1</div><div class=card>2</div></div></div>""",

    # v4 杀手 ④：scroller 装在 overflow:hidden 祖先里 → 必须用 intersectionRect
    "clipped_scroller": """<div style="height:150px;overflow:hidden">
        <div class=scr style="height:400px;overflow:auto"><div class=list>
        <div class=card>1</div><div class=card>2</div><div class=card>3</div>
        <div class=card>4</div></div></div></div>""",

    # v4 杀手 ⑤：祖先合成属性让闸② 整体假阴性
    "filtered": """<div style="filter:saturate(1.01)"><div class=list>
        <div class=card>1</div><div class=card>2</div><div class=card>3</div></div></div>""",

    # 闸① 的第二个轴：横向溢出视口的条目不算完整可见
    "wide": """<div class=list><div class=card>1</div>
        <div class=card style="width:3000px">2</div><div class=card>3</div></div>""",
}

# (fixture, 额外参数, 期望 exit, 期望在输出里出现的片段)
CASES = [
    ("normal",           [],                              0, "完整可见 3/3"),
    ("normal",           ["--min-visible", "5"],          1, "< --min-visible 5"),
    ("clip",             [],                              0, "完整可见 1/3"),
    ("opacity",          [],                              0, "完整可见 2/3"),
    ("hidden",           [],                              0, "完整可见 2/3"),
    # 实测：Chrome 的 isVisible 会因为一个**零高的兄弟节点**把相邻的完整可见条目判 false
    # （ground truth：该条 checkVisibility 与五点法都 true）。两条路径因此分岔 → unresolved
    ("zero",             [],                              3, "五点法读到 2 条"),
    ("covered",          [],                              0, "覆盖层"),
    # 实测：相邻卡片的 box-shadow 向上溢出 6px 压边，isVisible 把 4 条报成更少
    ("shadow",           [],                              3, "五点法读到 4 条"),
    ("fixedhead",        [],                              0, "扣掉 1 个 fixed"),
    ("fixedhead",        ["--max-item-ratio", "1.0"],     1, "> --max-item-ratio"),
    ("offscreen",        ["--scroller", ".scr"],          3, "band 面积为 0"),
    ("clipped_scroller", ["--scroller", ".scr"],          0, "intersectionRect"),
    ("filtered",         [],                              3, "合成属性"),
    ("wide",             [],                              0, "完整可见 2/3"),
    ("normal",           ["--items", ".nope"],            3, "一个都没匹配到"),
    ("normal",           ["--scroller", ".nope"],         2, "不存在"),
    # 阴性对照：把已知致病的 CSS 注进对照页面，工具必须从绿转红
    ("normal", ["--inject-css", ".list{filter:saturate(1.01)}"], 3, "合成属性"),
]


def _serve(root: Path) -> tuple[str, http.server.ThreadingHTTPServer]:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root))
    handler.log_message = lambda *_a, **_k: None     # type: ignore[assignment]
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{port}", srv


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="fsd-fx-"))
    for name, body in FIXTURES.items():
        (tmp / f"{name}.html").write_text(
            f"<!doctype html><meta charset=utf-8><style>{CSS}</style>{body}", encoding="utf-8")
    base, srv = _serve(tmp)

    failures = []
    try:
        for fx, extra, want_code, want_text in CASES:
            cmd = [sys.executable, TOOL, f"{base}/{fx}.html",
                   "--viewport", "800x600", "--settle-ms", "400"]
            if "--items" not in extra:
                cmd += ["--items", ".card"]
            cmd += extra
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=240)
            blob = p.stdout + p.stderr
            label = f"{fx} {' '.join(extra)}".strip()
            if p.returncode != want_code:
                failures.append(f"{label}: exit {p.returncode}，期望 {want_code}\n{blob[:600]}")
            elif want_text not in blob:
                failures.append(f"{label}: 输出缺 {want_text!r}\n{blob[:600]}")
            else:
                print(f"  ok  {label}  → exit {p.returncode}")
    finally:
        srv.shutdown()

    if failures:
        print("\n".join(["", "FAILURES:", *failures]))
        return 1
    print(f"\n{len(CASES)} cases passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
