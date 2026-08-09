#!/usr/bin/env python3
"""Terminal view of the same egress-network snapshot the /network page shows.

Data comes from tt-web itself rather than from a second `ip-check` call: when the
server is up the snapshot is pulled from /api/network, so the terminal normally
serves the cache the page is already serving instead of probing again; when it is
down the same `server.network()` function runs in-process, so both paths share one
error taxonomy instead of growing two. The server neither locks nor coalesces
concurrent cache misses, so this is a shared cache, not a guarantee that the two
readers see identical bytes.

Scope is deliberately this machine only, matching the page. Nothing here reaches
the machines in machines.json -- that file governs usage sync, not diagnostics.
"""

import argparse
import json
import os
import re
import sys
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATE_DIR = ROOT / "state"

# The server gives ip-check 30s before it times out; we must outlive that so a
# slow external API surfaces as ip-check's own timeout message rather than as a
# bare read error here, which would say nothing about the cause.
FETCH_TIMEOUT = 45

LABEL_WIDTH = 22

VERDICT_HEADLINES = {
    "high": "高风险 — 这条出口网络很可能影响 Claude / Codex 使用",
    "proxy-in-use": "可用，但正在走代理 — Claude 的反爬判定可能误伤",
    "low": "低风险 — 未发现影响 Claude / Codex 使用的信号",
    "unknown": "未知 — 本轮没有得出结论",
}

# Printed instead of any risk grade when a verdict input went unobserved. Without
# it the degraded run's headline is word-for-word the healthy one's, and a reader
# who scans only that line acts on a grade three of its four inputs never earned.
INCONCLUSIVE_HEADLINE = "证据不足 — %d 项判定输入本轮未取得观测，不给出风险档位"

# Section key -> (display name, what its absence means to the reader).
SECTIONS = ("local", "public", "risk", "spam", "tz_check")
SECTION_NAMES = {
    "local": "本机网络",
    "public": "公网出口",
    "risk": "代理 / 风险库",
    "spam": "垃圾信誉库",
    "tz_check": "时区一致性",
}


class ReportUnavailable(Exception):
    """No snapshot at all -- distinct from a snapshot that reports risk.

    Carries what the reader needs to act: what failed, and the first command to
    run about it.
    """

    def __init__(self, headline, detail, hint=None):
        super().__init__(headline)
        self.headline = headline
        self.detail = detail
        self.hint = hint


# --- collection ------------------------------------------------------------


def _live_server_port():
    """Port of a tt-web server that is actually running, or None."""
    try:
        pid = int((STATE_DIR / "pid").read_text().strip())
        port = int((STATE_DIR / "port").read_text().strip())
    except (OSError, ValueError):
        return None
    try:
        os.kill(pid, 0)
    except OSError:
        return None
    return port


def collect(force=False):
    """Return (snapshot, source_note). Prefers the running server's snapshot."""
    port = _live_server_port()
    detour = None
    if port is not None:
        url = "http://127.0.0.1:%d/api/network%s" % (port, "?force=1" if force else "")
        try:
            with urllib.request.urlopen(url, timeout=FETCH_TIMEOUT) as response:
                return json.load(response), "tt-web 服务 (:%d) 的缓存快照，与 /network 页面同源" % port
        except (urllib.error.URLError, OSError, ValueError) as exc:
            detour = "tt-web 服务在 :%d 但取数失败（%s），已改为本进程直接检测" % (port, exc)

    sys.path.insert(0, str(ROOT))
    import server

    snapshot = server.network({"force": ["1"]} if force else {})
    return snapshot, detour or "本进程直接运行 ip-check（tt-web 服务未运行）"


def _reject_unusable(snapshot):
    """Raise when the snapshot is an error envelope rather than a report."""
    if snapshot.get("installed") is False:
        raise ReportUnavailable(
            "ip-check 未安装，无法检测出口网络",
            snapshot.get("error") or "ip-check 不在 PATH 中",
            hint="安装：bash %s" % (ROOT / "install.sh"),
        )
    if snapshot.get("error"):
        raise ReportUnavailable(
            "出口网络检测失败",
            snapshot["error"],
            hint="重试：tt-web network --force",
        )


# --- formatting ------------------------------------------------------------


def _columns(text):
    """Terminal columns `text` occupies. CJK labels are two columns per char, so
    str.ljust (which counts characters) leaves the value column ragged."""
    return sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in text)


def _pad(text, width):
    return text + " " * max(width - _columns(text), 1)


def _kv(label, value):
    return "  %s%s" % (_pad(label, LABEL_WIDTH), value)


def _errors_by_section(snapshot):
    return {
        item.get("section"): item.get("message")
        for item in snapshot.get("errors") or []
        if item.get("section")
    }


def _probe_failed(text):
    """Whether an upstream display string is a wrapped failure rather than an answer.

    ip-check funnels several lookup failures into ordinary result text instead of
    raising, so `errors` stays empty and the section stays truthy. It uses more
    than one wording for it -- "获取失败" for the local probes, "查询失败（…）" for the
    remote lookups -- so match the shared marker rather than either phrasing; the
    values these fields otherwise carry are addresses, URLs and scores, none of
    which contain it.
    """
    return bool(text) and "失败" in str(text)


def _gaps(snapshot):
    """[(name, reason, feeds_verdict)] for dimensions with no positive observation.

    Keyed on whether the signal was actually obtained, not on whether the section
    key exists: a proxycheck timeout still returns a risk dict, just one whose
    score is null, and treating that as observed is how "not checked" silently
    becomes "passed". `feeds_verdict` separates the two claims the report makes --
    the verdict caveat may only name dimensions the verdict actually reads, while
    "nothing needs your attention" must account for every failed probe.
    """
    errors = _errors_by_section(snapshot)
    local = snapshot.get("local") or {}
    public = snapshot.get("public") or {}
    risk = snapshot.get("risk") or {}
    spam = snapshot.get("spam") or {}
    tz = snapshot.get("tz_check") or {}
    public_ok = bool(public.get("ok")) and "public" not in errors
    gaps = []

    if "local" in errors or not local:
        gaps.append((SECTION_NAMES["local"], "查询失败：%s" % errors.get("local", "无数据"), True))
    else:
        if _probe_failed(local.get("lan_ip")) or not local.get("lan_ip"):
            gaps.append(("局域网 IP", "未取得本机地址", False))
        if not local.get("dns"):
            # dns_has_cn is a verdict signal and it reads False on an empty list,
            # which is what "no resolver found" and "no CN resolver" both produce.
            gaps.append(("DNS 归属", "未取得 DNS 服务器列表，无法判断解析器地域", True))

    if not public_ok:
        gaps.append(
            (
                SECTION_NAMES["public"],
                "查询失败：%s" % (errors.get("public") or public.get("error") or "无返回"),
                True,
            )
        )
    elif risk.get("score") is None and (public.get("proxy") or public.get("hosting")):
        # The IP carries a proxy/hosting flag, so ip-check does escalate to the
        # risk lookup -- a null score here means that lookup did not answer.
        # (No flag at all is not a gap: ip-api's negative is the observation,
        # and the escalation is intentionally skipped.)
        gaps.append(
            (
                SECTION_NAMES["risk"],
                errors.get("risk") or risk.get("display") or "已触发查询，但未取得风险分",
                True,
            )
        )

    spam_raw = "；".join(line for line in spam.get("raw_lines") or [] if line)
    if "spam" in errors:
        gaps.append((SECTION_NAMES["spam"], "查询失败：%s" % errors["spam"], False))
    elif spam and spam.get("score") is None and _probe_failed(spam_raw):
        gaps.append((SECTION_NAMES["spam"], spam_raw, False))

    if "tz_check" in errors or not tz:
        gaps.append((SECTION_NAMES["tz_check"], "查询失败：%s" % errors.get("tz_check", "无数据"), True))
    elif tz.get("matched") is None:
        # Independent of why: an uncomparable timezone is a verdict signal the
        # verdict never got, whether or not the public lookup also failed.
        gaps.append(
            (
                SECTION_NAMES["tz_check"],
                "无法比对：公网信息缺失" if not public_ok else "无法比对：公网 IP 未返回时区",
                True,
            )
        )

    return gaps


def _not_queried_reason(public):
    """Why an escalated lookup has no result, when it is not a failure.

    "不适用" and "未查询" are opposite claims -- one says the check was correctly
    skipped, the other that it could not run -- so the flags have to be checked,
    not just whether the public lookup succeeded.
    """
    if not public.get("ok"):
        return "未查询：公网信息缺失，无法发起查询"
    if public.get("proxy") or public.get("hosting"):
        return "已触发查询，但未取得结果"
    return "不适用：公网 IP 无 proxy / hosting 标记，本项无需查询"


def _proxy_endpoint(value):
    """host:port of a proxy URL, credentials stripped."""
    stripped = re.sub(r"^[a-zA-Z][\w+.-]*://", "", str(value)).split("/")[0]
    return stripped.split("@")[-1]


def _blamed_proxy(snapshot, gaps):
    """(env name, host:port) when a failed probe names this machine's own proxy.

    Both facts are already in hand -- the timed-out address and the proxy env --
    and joining them is one string compare. Left unjoined, the reader is handed
    "公网出口查询失败" plus a proxy line sixteen rows below and asked to notice
    they are the same address, when the answer that matters is that Claude's own
    egress runs through the thing that just stopped answering.
    """
    # 实际用过的地址排在环境变量前面：探测走的是它，失败也该记在它头上。二者不同时——
    # 本进程的 env 早于最近一次线路切换——只认 env 会把读者指向一个本轮根本没连过的端口，
    # 他照着去查那个进程，只会发现它活得好好的。
    candidates = []
    effective = snapshot.get("proxy_effective") or {}
    if effective.get("source") == "published" and effective.get("address"):
        # 只有 published 才是"本轮确实从这里出去的"。unpublished / invalid 下本进程
        # 没接管选路，那个地址一次也没被用过，排在前面会把失败归给一个无关的端口。
        # label 与明细里那行同名：读者在同一屏里见到两种叫法，会以为是两个东西。
        candidates.append(("本次探测出口", effective["address"]))
    candidates.extend(sorted((snapshot.get("proxy_envs") or {}).items()))

    for _name, reason, _feeds in gaps:
        for key, value in candidates:
            endpoint = _proxy_endpoint(value)
            host, _, port = endpoint.partition(":")
            # Match host and port separately: urllib3 renders the address as
            # host='127.0.0.1', port=59625, never as host:port.
            if host and host in reason and (not port or port in reason):
                return key, endpoint
    return None


def _ipv6_undecidable(snapshot):
    """Whether the IPv6 signal rests on an absence ip-check cannot account for.

    `get_ipv6()` returns None both when IPv6 is off and when the probe failed, so
    a False `ipv6_leaked` is not an observation the verdict may lean on. Not a
    `_gaps` entry: there is no action for the reader to take and no round in which
    it resolves, so it belongs with the verdict caveat rather than in the list of
    things that went wrong this round.
    """
    local = snapshot.get("local") or {}
    return bool(local) and not local.get("ipv6_leaked")


def _age(timestamp):
    if not timestamp:
        return None
    try:
        collected = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    if collected.tzinfo is None:
        collected = collected.replace(tzinfo=timezone.utc)
    seconds = int((datetime.now(timezone.utc) - collected).total_seconds())
    if seconds < 0:
        return None
    if seconds < 60:
        return "%d 秒前" % seconds
    if seconds < 3600:
        return "%d 分钟前" % (seconds // 60)
    return "%.1f 小时前" % (seconds / 3600)


def render_headline(snapshot, source_note, lines):
    verdict = snapshot.get("verdict") or "unknown"
    lines.append("出口网络检查 · 本机")
    lines.append("")
    gaps = _gaps(snapshot)
    uncovered = [name for name, _, feeds_verdict in gaps if feeds_verdict]
    if uncovered:
        # A risk grade computed from inputs that never answered is not a weaker
        # grade, it is no grade. Qualifying "低风险" is not enough: the headline
        # is what a scanning reader acts on, and it read word-for-word the same
        # as a fully-healthy round.
        lines.append("结论  %s" % (INCONCLUSIVE_HEADLINE % len(uncovered)))
        lines.append("      未取得观测的是 —— %s" % "、".join(uncovered))
    else:
        lines.append("结论  %s" % VERDICT_HEADLINES.get(verdict, VERDICT_HEADLINES["unknown"]))
    if _ipv6_undecidable(snapshot):
        lines.append(
            "      注意：IPv6 一路不在结论覆盖内 —— ip-check 对「确实已关闭」与「探测失败」"
            "返回相同结果，本轮的「未检出地址」两者都可能"
        )

    timestamp = snapshot.get("timestamp")
    age = _age(timestamp)
    when = "%s（%s）" % (timestamp, age) if age else (timestamp or "未知")
    lines.append("采集  %s" % when)
    lines.append("来源  %s" % source_note)
    lines.append("范围  仅本机；其它机器不在本结论内，需分别在该机器上运行 ip-check")
    return gaps


def render_attention(snapshot, gaps, lines):
    """Everything the reader might have to act on, before any detail."""
    findings = [
        ("✗" if item.get("level") == "bad" else "⚠", item.get("text", ""))
        for item in snapshot.get("conclusions") or []
        if item.get("level") in ("bad", "warn")
    ]
    findings.sort(key=lambda pair: pair[0] != "✗")

    lines.append("")
    if not findings and not gaps:
        # "各项均正常" would contradict the coverage caveat printed just above it.
        lines.append(
            "需要注意  除上述覆盖限制外，本轮无其他需处置项。"
            if _ipv6_undecidable(snapshot)
            else "需要注意  无；本轮各项检测均已应答且正常，无需处置。"
        )
        return

    lines.append("需要注意")
    blamed = _blamed_proxy(snapshot, gaps)
    if blamed:
        key, endpoint = blamed
        lines.append("  ! %s%s=%s 未在探测预算内应答" % (_pad("本地代理无响应", 14), key, endpoint))
        lines.append("    影响：Claude / Codex 的出口请求走同一代理，此刻可能同样超时")
        effective = snapshot.get("proxy_effective") or {}
        if effective.get("source") == "published" and effective.get("address"):
            # 首因排序不能照搬"进程挂了"：这个地址来自一个目前由人手工维护的文件，所以
            # 「文件写的不是你此刻在用的线路」比「进程挂了」更常见。把它排在前面，否则
            # 读者会去查一个好端端的进程，查完一无所获还以为工具在胡说。
            lines.append("    下一步：先确认 %s 写的就是你此刻在用的线路（该文件目前需手工更新），"
                         % (effective.get("path") or "~/.config/agent-proxy/current-proxy"))
            lines.append("            再确认该代理进程在跑；改完用 `tt-web network --force` 重测")
        else:
            lines.append("    下一步：确认该代理进程在跑，再 `tt-web network --force` 重测")
    for mark, text in findings:
        lines.append("  %s %s" % (mark, text))
    for name, reason, _ in gaps:
        # A dimension that only failed because an upstream one did is a
        # consequence, not a second thing to look into; it stays in 明细.
        if "公网信息缺失" in reason and any(n == SECTION_NAMES["public"] for n, _, _ in gaps):
            continue
        if blamed and blamed[1].split(":")[0] in reason:
            lines.append("  ? %s上述代理未应答，本项未取得观测" % _pad(name, 14))
            continue
        lines.append("  ? %s%s" % (_pad(name, 14), reason))
    if findings:
        lines.append("  处置建议见 %s" % (ROOT / "NETWORK-REMEDIATION.md"))


def _redact_proxy(value):
    """Mask credentials in a proxy URL. This report gets pasted into issues and
    chats, so a `http://user:pass@host` env var must not survive verbatim."""
    match = re.match(r"^([a-zA-Z][\w+.-]*://)([^/@]+)@(.*)$", str(value))
    return "%s***@%s" % (match.group(1), match.group(3)) if match else value


def render_details(snapshot, gaps, lines):
    gap_reasons = {name: reason for name, reason, _ in gaps}
    errors = _errors_by_section(snapshot)
    local = snapshot.get("local") or {}
    public = snapshot.get("public") or {}
    risk = snapshot.get("risk") or {}
    spam = snapshot.get("spam") or {}
    tz = snapshot.get("tz_check") or {}

    lines.append("")
    lines.append("明细")

    lines.append(" 本机网络")
    if local:
        dns = local.get("dns") or []
        lines.append(_kv("局域网 IP", local.get("lan_ip") or "—"))
        # Not "已禁用": ip-check returns no address both when IPv6 is genuinely
        # off and when the probe itself failed, and it does not distinguish them.
        lines.append(
            _kv("IPv6", "泄漏：%s" % local["ipv6"] if local.get("ipv6_leaked") else "未检出地址")
        )
        lines.append(
            _kv(
                "DNS 服务器",
                "、".join(
                    "%s%s" % (entry.get("ip", "?"), " [%s]" % entry["country"] if entry.get("country") else "")
                    for entry in dns
                )
                or "—",
            )
        )
        if not dns:
            # dns_has_cn reads False on an empty list, so "无 CN 解析器" here would
            # report a negative that no resolver lookup ever produced.
            lines.append(_kv("DNS 归属", "未取得解析器列表，无法判断"))
        else:
            lines.append(_kv("DNS 归属", "检出 CN 解析器" if local.get("dns_has_cn") else "无 CN 解析器"))
    else:
        lines.append(_kv("状态", "查询失败：%s" % errors.get("local", "无数据")))

    lines.append(" 公网出口")
    if public.get("ok"):
        location = " / ".join(x for x in (public.get("country"), public.get("region"), public.get("city")) if x)
        lines.append(_kv("公网 IP", public.get("ip") or "—"))
        lines.append(_kv("归属地", location or "—"))
        lines.append(_kv("ISP", public.get("isp") or "—"))
        lines.append(_kv("组织", public.get("org") or "—"))
        lines.append(
            _kv("时区", "%s (%s)" % (public["timezone"], public.get("tz_offset") or "—") if public.get("timezone") else "—")
        )
    else:
        lines.append(_kv("状态", "查询失败：%s" % (public.get("error") or errors.get("public") or "无数据")))

    lines.append(" 代理 / 风险")
    if risk.get("score") is not None:
        # Threshold beside the value: the reader judging "is 66 bad?" should not
        # have to find the rule line a screen away.
        lines.append(
            _kv("风险分 (proxycheck)", "%s/100（≥70 判为高风险）" % risk["score"])
        )
        lines.append(_kv("类型 (proxycheck)", risk.get("type") or "—"))
    else:
        lines.append(
            _kv(
                "风险分 (proxycheck)",
                gap_reasons.get(SECTION_NAMES["risk"])
                or risk.get("display")
                or _not_queried_reason(public),
            )
        )
    # Both flags come from the public lookup; rendering its absence as "否" would
    # report a clean result the lookup never produced.
    if public.get("ok"):
        lines.append(_kv("标记为代理", "是" if public.get("proxy") or risk.get("marked_proxy") else "否"))
        lines.append(_kv("标记为机房 IP", "是" if public.get("hosting") else "否"))
    else:
        lines.append(_kv("标记为代理", "未知：公网查询失败"))
        lines.append(_kv("标记为机房 IP", "未知：公网查询失败"))
    if spam:
        score = spam.get("score")
        if score is not None:
            lines.append(_kv("垃圾信誉分", "%s/100 %s" % (score, spam.get("level") or "")))
            lines.append(
                _kv("被举报次数", str(spam.get("frequency")) if spam.get("frequency") is not None else "—")
            )
        else:
            # Queried, but the upstream text did not parse into a score. Showing
            # the raw answer beats "—", which reads as "clean".
            raw = "；".join(line for line in spam.get("raw_lines") or [] if line)
            lines.append(_kv("垃圾信誉库", raw or "已查询，未解析出分数"))
    else:
        lines.append(
            _kv(
                "垃圾信誉库",
                gap_reasons.get(SECTION_NAMES["spam"])
                or _not_queried_reason(public),
            )
        )
    # 与下面那行环境变量分开写：它们经常不是同一个地址，而「本轮从哪出去的」才是读者
    # 判断结论可不可信、以及该去查哪个进程的依据。合成一行会把这个差异藏起来。
    effective = snapshot.get("proxy_effective") or {}
    source = effective.get("source")
    # 措辞守两条：不说"当前线路"——这一侧只知道那个文件写了什么，不知道它是不是此刻
    # 生效的那条（发布方尚未上线，文件由人手工维护，陈旧值与新值同形）；也不留"发布
    # 文件""未接管"这类只有实现者懂的说法，路径直接写出来，读者才知道去哪看、改什么。
    path = effective.get("path") or "~/.config/agent-proxy/current-proxy"
    if source == "published":
        address = effective.get("address")
        lines.append(_kv(
            "本次探测出口",
            "%s（按 %s）" % (_redact_proxy(address), path) if address
            else "直连（%s 指定不走代理）" % path,
        ))
    elif source:
        # 这里不报单一地址：requests 会按 http / https 各自取不同的环境变量，挑其中一个
        # 说成"本次出口"在两者不同时就是假的。指向下一行，并说清为什么落到那里。
        # reason 由采集侧按具体 errno 给（不存在 / 没有读取权限 / 是一个目录），不在这里
        # 统一说成"不存在"——那会让权限问题的读者去创建一个已经在那儿的文件。
        why = "%s %s" % (path, effective.get("reason") or "读不出来")
        lines.append(_kv("本次探测出口", "见下行环境变量（%s）" % why))

    envs = snapshot.get("proxy_envs") or {}
    lines.append(
        _kv(
            "本地代理环境变量",
            "、".join("%s=%s" % (key, _redact_proxy(value)) for key, value in sorted(envs.items()))
            if envs
            else "未设置",
        )
    )

    lines.append(" 时区一致性")
    if tz:
        matched = tz.get("matched")
        verdict = "一致" if matched is True else "不一致" if matched is False else "无法比对"
        lines.append(_kv("本机时区", "%s (%s)" % (tz.get("cli_tz") or "—", tz.get("cli_offset") or "—")))
        lines.append(
            _kv("公网 IP 时区", "%s (%s)" % (public["timezone"], public.get("tz_offset") or "—") if public.get("timezone") else "—")
        )
        lines.append(_kv("比对结果", verdict))
    else:
        lines.append(_kv("状态", "查询失败：%s" % errors.get("tz_check", "无数据")))


def render(snapshot, source_note):
    # No "已核对正常" block: it restated 明细 in upstream's English while 明细
    # already carries the same facts in the reader's language, and pinning display
    # wording to those strings makes them a parse surface nobody declared.
    lines = []
    gaps = render_headline(snapshot, source_note, lines)
    render_attention(snapshot, gaps, lines)
    render_details(snapshot, gaps, lines)
    lines.append("")
    lines.append(
        "判定规则  IPv6 泄漏 / 检出 CN DNS 解析器 / 风险分 ≥ 70 / 时区不一致，"
        "任一命中即判高风险；仅检出代理则判为「走代理但可用」；都没命中才是低风险。"
    )
    footer = "网页版 tt-web open → /network    结构化输出 tt-web network --json"
    if gaps:
        footer = "重新探测 tt-web network --force    " + footer
    lines.append(footer)
    return "\n".join(lines)


# --- entry point -----------------------------------------------------------


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="tt-web network",
        description=(
            "查看本机出口网络诊断与安全审计（与 tt-web 的 /network 页面同源）。"
            "退出码只表示报告是否产出：0 = 已产出（不论风险高低），2 = 无法产出。"
        ),
    )
    parser.add_argument("--json", action="store_true", help="输出 /api/network 的原始 JSON")
    parser.add_argument("--force", action="store_true", help="跳过缓存，强制重新检测")
    args = parser.parse_args(argv)

    try:
        snapshot, source_note = collect(force=args.force)
    except Exception as exc:  # collection itself broke; report it as such
        print("出口网络检测无法执行：%s" % exc, file=sys.stderr)
        return 2

    if args.json:
        # Machine view stays raw: the human framing above is this command's own,
        # and baking it into the JSON would make it a second contract to keep.
        print(json.dumps(snapshot, ensure_ascii=False, indent=2, sort_keys=True, default=str))
        return 0 if not (snapshot.get("error") or snapshot.get("installed") is False) else 2

    try:
        _reject_unusable(snapshot)
    except ReportUnavailable as exc:
        print(exc.headline, file=sys.stderr)
        print("原因  %s" % exc.detail, file=sys.stderr)
        if exc.hint:
            print("下一步  %s" % exc.hint, file=sys.stderr)
        return 2

    print(render(snapshot, source_note))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
