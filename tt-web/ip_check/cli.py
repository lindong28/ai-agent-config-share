#!/usr/bin/env python3
"""
ipcheck — 网络环境诊断工具
检测本机 IP、IPv6、DNS、公网信息、代理状态、时区
支持 macOS / Linux / Windows
"""

import socket
import ipaddress
import os
import sys
import subprocess
import concurrent.futures
import datetime
import re
import platform

import requests
from urllib.parse import urlsplit as _urlsplit

try:
    from zoneinfo import ZoneInfo as _ZI
except ImportError:
    _ZI = None

# ── 编码修正（Windows cmd 默认非 UTF-8）────────────────────
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ('utf-8', 'utf8'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except AttributeError:
        pass

IS_WIN = platform.system() == 'Windows'


# ── 已知 DNS ──────────────────────────────────────────────
KNOWN_DNS = {
    '1.1.1.1':         'Cloudflare (US)',
    '1.0.0.1':         'Cloudflare (US)',
    '1.1.1.2':         'Cloudflare for Families (US)',
    '1.0.0.2':         'Cloudflare for Families (US)',
    '1.1.1.3':         'Cloudflare for Families (US)',
    '1.0.0.3':         'Cloudflare for Families (US)',
    '8.8.8.8':         'Google Public DNS (US)',
    '8.8.4.4':         'Google Public DNS (US)',
    '9.9.9.9':         'Quad9 (US)',
    '149.112.112.112': 'Quad9 (US)',
    '208.67.222.222':  'OpenDNS/Cisco (US)',
    '208.67.220.220':  'OpenDNS/Cisco (US)',
    '223.5.5.5':       'AliDNS 阿里 (CN)',
    '223.6.6.6':       'AliDNS 阿里 (CN)',
    '119.29.29.29':    'DNSPod 腾讯 (CN)',
    '182.254.116.116': 'DNSPod 腾讯 (CN)',
    '114.114.114.114': '114DNS (CN)',
    '114.114.115.115': '114DNS (CN)',
    '180.76.76.76':    'BaiduDNS 百度 (CN)',
    '1.2.4.8':         'CNNIC (CN)',
    '210.2.4.8':       'CNNIC (CN)',
    '94.140.14.14':    'AdGuard (CY)',
    '94.140.15.15':    'AdGuard (CY)',
    '185.228.168.9':   'CleanBrowsing (US)',
    '185.228.169.9':   'CleanBrowsing (US)',
    '76.76.2.0':       'Alternate DNS (US)',
    '76.76.10.0':      'Alternate DNS (US)',
}


def dns_label(ip):
    if ip in KNOWN_DNS:
        return f"{ip}  {KNOWN_DNS[ip]}"
    try:
        if ipaddress.ip_address(ip).is_private:
            return f"{ip}  局域网路由器"
    except Exception:
        pass
    return ip


def make_zone(name):
    if not _ZI or not name:
        return None
    try:
        return _ZI(name)
    except Exception:
        return None


def _val(v, fallback="未知"):
    return v if v else warn(fallback)


# ── 颜色 ─────────────────────────────────────────────────
def _init_color():
    if IS_WIN:
        try:
            import colorama
            colorama.init()
            return True
        except ImportError:
            pass
        try:
            import ctypes
            h = ctypes.windll.kernel32.GetStdHandle(-11)
            m = ctypes.c_ulong()
            ctypes.windll.kernel32.GetConsoleMode(h, ctypes.byref(m))
            ctypes.windll.kernel32.SetConsoleMode(h, m.value | 0x0004)
            return True
        except Exception:
            return False
    return True

_COLOR = _init_color()


class C:
    RESET  = "\033[0m"  if _COLOR else ""
    BOLD   = "\033[1m"  if _COLOR else ""
    RED    = "\033[91m" if _COLOR else ""
    GREEN  = "\033[92m" if _COLOR else ""
    YELLOW = "\033[93m" if _COLOR else ""
    GRAY   = "\033[90m" if _COLOR else ""

ANSI_RE = re.compile(r'\033\[[0-9;]*m')


def char_width(c):
    cp = ord(c)
    if (0x2E80 <= cp <= 0x303E or 0x3040 <= cp <= 0x33FF or
        0x3400 <= cp <= 0x4DBF or 0x4E00 <= cp <= 0x9FFF or
        0xAC00 <= cp <= 0xD7AF or 0xF900 <= cp <= 0xFAFF or
        0xFE30 <= cp <= 0xFE6F or 0xFF00 <= cp <= 0xFF60 or
        0x20000 <= cp <= 0x2FFFD):
        return 2
    return 1


def display_len(s):
    return sum(char_width(c) for c in ANSI_RE.sub('', s))


def ok(v):   return f"{C.GREEN}{v}{C.RESET}"
def warn(v): return f"{C.YELLOW}{v}{C.RESET}"
def bad(v):  return f"{C.RED}{v}{C.RESET}"


def risk_color(score):
    if score < 30:
        return C.GREEN, "低风险"
    if score < 70:
        return C.YELLOW, "中风险"
    return C.RED, "高风险"


# ── 表格渲染 ──────────────────────────────────────────────
COL_LABEL, COL_VALUE = 18, 46

def tbl_top(): print(f"  ╔{'═'*(COL_LABEL+2)}╤{'═'*(COL_VALUE+2)}╗")
def tbl_sep(): print(f"  ╠{'═'*(COL_LABEL+2)}╪{'═'*(COL_VALUE+2)}╣")
def tbl_bot(): print(f"  ╚{'═'*(COL_LABEL+2)}╧{'═'*(COL_VALUE+2)}╝")


def tbl_row(label, value):
    value = str(value)
    lpad = ' ' * max(0, COL_LABEL - display_len(label))
    vpad = ' ' * max(0, COL_VALUE - display_len(value))
    lstr = f"{label}{lpad}" if label else ' ' * COL_LABEL
    print(f"  ║ {lstr} │ {value}{vpad} ║")


# ── 数据采集 ─────────────────────────────────────────────
def get_lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except Exception:
        return warn("获取失败")


def get_ipv6():
    try:
        with socket.socket(socket.AF_INET6, socket.SOCK_DGRAM) as s:
            s.connect(("2001:4860:4860::8888", 80))
            ip = s.getsockname()[0]
            if ip and ip not in ('', '::'):
                return ip
    except Exception:
        pass
    return None


def get_dns_servers():
    servers = []
    if IS_WIN:
        try:
            r = subprocess.run(
                ['powershell', '-NoProfile', '-Command',
                 'Get-DnsClientServerAddress -AddressFamily IPv4 | '
                 'Select-Object -ExpandProperty ServerAddresses'],
                capture_output=True, text=True, timeout=5, encoding='utf-8',
            )
            seen = set()
            for line in r.stdout.splitlines():
                ip = line.strip()
                if not ip:
                    continue
                try:
                    ipaddress.ip_address(ip)
                    if ip not in seen:
                        seen.add(ip)
                        servers.append(ip)
                except ValueError:
                    pass
        except Exception:
            pass
    else:
        try:
            seen = set()
            with open('/etc/resolv.conf') as f:
                for line in f:
                    if line.strip().startswith('nameserver'):
                        ip = line.split()[1]
                        if ip not in seen:
                            seen.add(ip)
                            servers.append(ip)
        except Exception:
            pass
        if not servers:
            try:
                r = subprocess.run(
                    ['scutil', '--dns'], capture_output=True, text=True, timeout=3,
                )
                seen = set()
                for line in r.stdout.splitlines():
                    line = line.strip()
                    if line.startswith('nameserver['):
                        ip = line.split(':', 1)[1].strip()
                        if ip not in seen:
                            seen.add(ip)
                            servers.append(ip)
            except Exception:
                pass
    return servers


# 约定由 system-config 的 shell 层在每次切换代理线路后，把「此刻生效的地址」写进这个
# 文件（直连时写空行），且必须原子替换——见下方 resolve_route 对瞬态空文件的说明。
# 该发布方尚未实现：目前这个文件由人手工维护，所以它说的不一定就是此刻生效的线路。
AGENT_PROXY_PUBLISHED = os.path.expanduser("~/.config/agent-proxy/current-proxy")

# 只认这两个 scheme。SOCKS 不在其列不是因为 requests 不支持语法，而是它需要 PySocks，
# 而这里没装——`socks5://...` 会一路通过校验、关掉环境代理，然后让三个探测一起挂在
# `InvalidSchema: Missing dependencies for SOCKS support`。判据是"这个进程此刻真能用"，
# 不是"requests 名义上支持"。本机四条线路本来也都是本地 HTTP 代理（SOCKS 那一段由
# gost 在上游转换掉了）。将来要放开，先把依赖装进 install.sh。
_PROXY_SCHEMES = frozenset(("http", "https"))


def _redact_userinfo(text):
    """遮蔽 URL 里的 user:pass@ —— 这段文本会进终端与 JSON，可能被截图或贴进 issue。

    字符类不排除空白：会走到这里的多半是**畸形**内容（合法地址根本进不了 invalid 分支），
    而 `http://alice:hunter2 @proxy:8080` 这种手滑写法里，密码同样是密码。以 `@` 为界，
    宁可多遮一点。
    """
    return re.sub(r"(?<=//)[^/@]+(?=@)", "***", str(text))


def _usable_proxy_url(raw):
    """能不能直接交给 requests 当代理用。

    不用正则判：`http://127.0.0.1:5952O`（端口把 0 打成字母 O）、`http://:59520`（没有
    主机）、`http://host:99999`（端口越界）都能被写得形似 URL 的正则放过，而 urllib3 到
    真正发请求时才解析失败——那时它已经被当成权威线路、环境变量也已被关掉。让
    urlsplit 去解析，非法端口它会自己抛 ValueError。
    """
    # urlsplit 会悄悄剥掉 tab / 换行等控制字符，于是 `http://host:\t8080` 在这里解析成
    # 一个漂亮的地址，而 urllib3 拿到原串时抛 LocationParseError。先自己拦掉。
    if any(ch.isspace() or ord(ch) < 32 or ord(ch) == 127 for ch in raw):
        return False
    try:
        parts = _urlsplit(raw)
        parts.port  # 触发端口解析：非数字或越界在此抛 ValueError
    except ValueError:
        return False
    return bool(
        parts.scheme.lower() in _PROXY_SCHEMES
        and parts.hostname
        and not parts.path.strip("/")
        and not parts.query
        and not parts.fragment
    )


def resolve_route():
    """整轮探测共用的选路决定：{"address", "source", "reason"}。

    source 的三种取值，各自是一个明确的断言：
      published   —— 发布文件给出了一个可用地址（为空即"这条线路直连"）。注意它断言的
                     是"文件这么写的"，不是"这就是此刻生效的线路"：发布方尚未上线，
                     陈旧值与新值同形，本侧分辨不出，所以报告措辞是"发布文件指定"。
      unpublished —— 读不到发布文件，本进程不接管选路，requests 照常用环境变量。
      invalid     —— 文件在、但内容不是一个能用的代理地址；同样不接管，并说明原因。

    为什么不能只靠 HTTP_PROXY：进程在 fork 那一刻拷贝一次环境，此后线路再怎么切都与它
    无关。tt-web server 是长驻的，于是「启动时是腾讯线路、之后切到 GCP」会让它一直朝着
    已经停掉的 gost 端口发请求——每条线路的端口固定且互不相同，坏掉的地址不会自己变好。

    为什么整轮只解析一次：一轮里有三个出站请求，逐个各读一次文件的话，用户恰好在中途
    切线路就会让同一份快照里的公网 IP 与风险分来自两条不同线路，而报告最后记下的是第
    三个值——那样「本次探测出口」这一行就是假的。
    """
    try:
        with open(AGENT_PROXY_PUBLISHED) as fh:
            raw = fh.read().strip()
    except OSError as e:
        # 不存在、不可读、是目录——都只说明这里问不出答案，不说明该直连。但它们要修的
        # 东西不同，压成一句"不存在"会让权限问题的读者去创建一个已经在那儿的文件。
        reason = {
            FileNotFoundError: "不存在",
            NotADirectoryError: "不存在",
            PermissionError: "没有读取权限",
            IsADirectoryError: "是一个目录，不是文件",
        }.get(type(e)) or "读不出来：%s" % e
        return {"address": "", "source": "unpublished", "reason": reason,
                "path": AGENT_PROXY_PUBLISHED}
    except UnicodeDecodeError as e:
        # 文件被非文本内容覆写。这行在 collect_all 的各段保护性 try 之外，漏出去就不是
        # 退化成 fallback，而是整份报告生不出来。
        return {"address": "", "source": "invalid", "reason": "内容不是文本：%s" % e, "path": AGENT_PROXY_PUBLISHED}
    if raw and not _usable_proxy_url(raw):
        return {
            "address": "",
            "source": "invalid",
            # 先遮盖再截断：反过来的话，超过 80 字符的 user:password@ 会把 `@` 甩到截断
            # 位置之外，遮盖的正则就看不见它，密码照样进终端和 JSON。
            "reason": "内容不是可用的代理地址：%r" % (_redact_userinfo(raw)[:80],),
            "path": AGENT_PROXY_PUBLISHED,
        }
    return {"address": raw, "source": "published", "reason": "", "path": AGENT_PROXY_PUBLISHED}


def _egress_session(route=None):
    """A requests session pinned to one route for the whole round.

    trust_env=False is the point: with it left on, requests re-reads the
    inherited HTTP_PROXY and would put the stale address back underneath us —
    including in the direct-connection case, where the whole intent is to
    bypass a proxy the environment still names. It also drops the CA-bundle
    vars, which have nothing to do with routing — a host with a corporate MITM
    bundle would start failing TLS on the two HTTPS probes — so those are
    carried over explicitly.
    """
    route = route or resolve_route()
    session = requests.Session()
    if route.get("source") != "published":
        # 没有权威答案时不接管：那台主机的环境变量该怎么用还怎么用。
        return session
    session.trust_env = False
    for var in ("REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"):
        bundle = os.environ.get(var)
        if bundle:
            session.verify = bundle
            break
    if route["address"]:
        session.proxies.update({"http": route["address"], "https": route["address"]})
    return session


def get_public_info(route=None):
    try:
        resp = _egress_session(route).get(
            "http://ip-api.com/json/",
            params={"fields": "status,message,country,regionName,city,isp,org,proxy,hosting,query,timezone"},
            timeout=6,
        )
        return resp.json()
    except Exception as e:
        return {"status": "fail", "message": str(e)}


def get_ip_risk(ip, route=None):
    try:
        resp = _egress_session(route).get(
            f"https://proxycheck.io/v2/{ip}",
            params={"risk": 1, "vpn": 1, "asn": 1},
            timeout=6,
        )
        data = resp.json().get(ip, {})
        risk  = data.get("risk")
        itype = data.get("type", "")
        proxy = data.get("proxy", "")
        parts = []
        score = None
        if risk is not None:
            score = int(risk)
            color, level = risk_color(score)
            parts.append(f"{color}{score}/100 {level}{C.RESET}")
        if itype:
            parts.append(f"类型 {itype}")
        if proxy == "yes":
            parts.append(bad("已标记为代理"))
        display = "  ".join(parts) if parts else warn("暂无数据")
        return display, score
    except Exception as e:
        return warn(f"查询失败（{e}）"), None


def get_stopforumspam(ip, route=None):
    try:
        resp = _egress_session(route).get(
            "https://api.stopforumspam.org/api",
            params={"json": 1, "ip": ip},
            timeout=(6, 10),
        )
        data = resp.json().get("ip", {})
        if not data.get("appears"):
            return [ok("未收录  低风险 ✓")]
        confidence = float(data.get("confidence", 0))
        frequency  = int(data.get("frequency", 0))
        last_seen  = (data.get("lastseen") or "")[:10]
        color, level = risk_color(confidence)
        lines = [f"{color}{confidence:.1f}/100 {level}{C.RESET}  举报 {frequency} 次"]
        if last_seen:
            lines.append(f"最近举报 {last_seen}")
        return lines
    except Exception as e:
        return [warn(f"查询失败（{e}）")]


def _collect_risk_probes(ip, route=None):
    """Run the two independent reputation lookups with a bounded fan-out."""
    results = {}
    futures = {}
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            for name, probe in (
                ("risk", get_ip_risk),
                ("spam", get_stopforumspam),
            ):
                try:
                    futures[name] = executor.submit(probe, ip, route)
                except Exception as exc:
                    results[name] = (None, exc)
        for name, future in futures.items():
            try:
                results[name] = (future.result(), None)
            except Exception as exc:
                results[name] = (None, exc)
    except Exception as exc:
        for name in ("risk", "spam"):
            results.setdefault(name, (None, exc))
    return results


def get_proxy_envs():
    seen = {}
    for key in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
                "http_proxy", "https_proxy", "all_proxy"]:
        val = os.environ.get(key)
        if val and val not in seen.values():
            seen[key.upper()] = val
    return seen


def collect_all() -> dict:
    """Collect all data and return as structured dict. Used by --json mode and
    by external consumers like tt-web. Mirrors the same get_* functions main()
    uses, but normalizes output to JSON-friendly types (ANSI strings stripped).

    Per-section partial failure: if any get_* call raises, the corresponding
    section is set to None (or {"ok": False}) and an entry is appended to the
    "errors" list, so callers can render partial data gracefully.
    """
    import datetime as _dt
    import re as _re

    try:
        from ip_check import __version__ as _pkg_version
    except ImportError:
        _pkg_version = "0.1.0"

    ansi_strip = _re.compile(r'\033\[[0-9;]*m')

    def _strip(s):
        return ansi_strip.sub('', str(s)) if s is not None else None

    def _risk_level(score):
        if score is None:
            return None
        if score < 30:
            return "low"
        if score < 70:
            return "medium"
        return "high"

    def _parse_risk_type(display):
        if not display:
            return None
        match = _re.search(r"(?:类型|type)\s+([A-Za-z0-9_-]+)", display, _re.IGNORECASE)
        return match.group(1) if match else None

    def _parse_spam_lines(lines):
        raw_lines = [_strip(line) for line in lines]
        spam = {"raw_lines": raw_lines}
        joined = " ".join(line for line in raw_lines if line)

        score_match = _re.search(
            r"([0-9]+(?:\.[0-9]+)?)/100\s+([A-Za-z]+|低风险|中风险|高风险)",
            joined,
            _re.IGNORECASE,
        )
        if score_match:
            spam["score"] = float(score_match.group(1))
            level = score_match.group(2).lower()
            if level == "low" or "低" in level:
                spam["level"] = "low"
            elif level == "medium" or "中" in level:
                spam["level"] = "medium"
            elif level == "high" or "高" in level:
                spam["level"] = "high"

        frequency_match = _re.search(
            r"(?:举报|reports?)\s*([0-9]+)\s*(?:次|times?)?",
            joined,
            _re.IGNORECASE,
        )
        if frequency_match:
            spam["frequency"] = int(frequency_match.group(1))

        last_seen_match = _re.search(
            r"(?:最近举报|last(?:\s+spam)?\s+report(?:ed)?|last\s+seen)\s*([0-9]{4}-[0-9]{2}-[0-9]{2})",
            joined,
            _re.IGNORECASE,
        )
        if last_seen_match:
            spam["last_seen"] = last_seen_match.group(1)

        return spam

    errors = []
    out = {
        "version": _pkg_version,
        "timestamp": _dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "system": {"platform": platform.system(), "python": platform.python_version()},
        "local": None,
        "public": None,
        "risk": None,
        "spam": None,
        "proxy_envs": {},
        "tz_check": None,
        "conclusions": [],
        "verdict": "unknown",
        "errors": errors,
    }

    try:
        lan = get_lan_ip()
        ipv6 = get_ipv6()
        dns_raw = get_dns_servers()
        dns_entries = []
        for ip in dns_raw:
            label = KNOWN_DNS.get(ip, "")
            country = None
            if label:
                if "(CN)" in label:
                    country = "CN"
                elif "(US)" in label:
                    country = "US"
                elif "(CY)" in label:
                    country = "CY"
            dns_entries.append({"ip": ip, "label": label or None, "country": country})
        out["local"] = {
            "lan_ip": _strip(lan),
            "ipv6": ipv6,
            "ipv6_leaked": ipv6 is not None,
            "dns": dns_entries,
            "dns_has_cn": any(e["country"] == "CN" for e in dns_entries),
        }
    except Exception as e:
        errors.append({"section": "local", "message": str(e)})

    # 选路在任何出站请求之前定一次，本轮三个请求共用它，快照记的也是它。中途解析会让
    # 「本次探测出口」记录一个可能没被任何请求用过的地址（用户恰在两次请求之间切了线路）。
    route = resolve_route()
    out["proxy_effective"] = {
        "address": route["address"],
        "source": route["source"],
        "reason": route["reason"],
        # path 必须一起进快照：报告要拿它告诉读者去哪看。漏掉它时终端看着仍然正确，
        # 因为报告的兜底字符串恰好等于默认路径——常量一改就会指向错的文件，而 capture
        # 依然全对。
        "path": route["path"],
    }

    try:
        pub = get_public_info(route)
        if pub.get("status") == "success":
            tz_name = pub.get("timezone")
            tz_off = None
            if tz_name:
                zi = make_zone(tz_name)
                if zi:
                    tz_off = _utc_str(_dt.datetime.now(zi).utcoffset())
            out["public"] = {
                "ok": True,
                "ip": pub.get("query"),
                "country": pub.get("country"),
                "region": pub.get("regionName"),
                "city": pub.get("city"),
                "isp": pub.get("isp"),
                "org": pub.get("org"),
                "timezone": tz_name,
                "tz_offset": tz_off,
                "proxy": bool(pub.get("proxy")),
                "hosting": bool(pub.get("hosting")),
            }
        else:
            message = pub.get("message", "unknown")
            out["public"] = {"ok": False, "error": message}
            errors.append({"section": "public", "message": message})
    except Exception as e:
        errors.append({"section": "public", "message": str(e)})

    # Match upstream main() gating: only call proxycheck and stopforumspam when
    # ip-api marks the public IP as proxy or hosting, preserving free quotas.
    pub_data = out.get("public") or {}
    if pub_data.get("ok") and (pub_data.get("proxy") or pub_data.get("hosting")):
        ip = pub_data.get("ip")
        probes = _collect_risk_probes(ip, route)
        risk_result, risk_error = probes["risk"]
        if risk_error is None:
            risk_display, risk_score = risk_result
            risk_display = _strip(risk_display)
            out["risk"] = {
                "score": risk_score,
                "level": _risk_level(risk_score),
                "type": _parse_risk_type(risk_display),
                "marked_proxy": pub_data.get("proxy", False),
                "display": risk_display,
            }
        else:
            errors.append({"section": "risk", "message": str(risk_error)})
        spam_lines, spam_error = probes["spam"]
        if spam_error is None:
            out["spam"] = _parse_spam_lines(spam_lines)
        else:
            errors.append({"section": "spam", "message": str(spam_error)})

    try:
        out["proxy_envs"] = get_proxy_envs()
    except Exception as e:
        errors.append({"section": "proxy_envs", "message": str(e)})

    try:
        cli_dt = _dt.datetime.now().astimezone()
        cli_offset = cli_dt.utcoffset()
        tz_name, is_iana = get_cli_tz_name()
        matched = None
        match_label = None
        if pub_data.get("ok") and pub_data.get("timezone"):
            pub_zi = make_zone(pub_data["timezone"])
            pub_offset = _dt.datetime.now(pub_zi).utcoffset() if pub_zi else None
            if is_iana:
                matched = (tz_name == pub_data["timezone"])
                match_label = "Match" if matched else "Mismatch"
            elif pub_offset is not None:
                matched = (cli_offset == pub_offset)
                match_label = "UTC offset match" if matched else "Mismatch"
        out["tz_check"] = {
            "cli_tz": tz_name,
            "cli_offset": _utc_str(cli_offset),
            "matched": matched,
            "match_label": match_label,
        }
    except Exception as e:
        errors.append({"section": "tz_check", "message": str(e)})

    conclusions = []
    local = out.get("local") or {}
    risk = out.get("risk") or {}
    tz = out.get("tz_check") or {}
    hard_high = {
        "ipv6": bool(local.get("ipv6_leaked")),
        "dns": bool(local.get("dns_has_cn")),
        "risk": bool(risk.get("score") is not None and risk.get("score") >= 70),
        "tz": bool(tz.get("matched") is False),
    }
    proxy_detected = bool(pub_data.get("proxy") or risk.get("marked_proxy"))

    if local.get("ipv6_leaked"):
        conclusions.append({"level": "bad", "text": "IPv6 leak detected; real address is exposed"})
    elif local:
        conclusions.append({"level": "ok", "text": "IPv6 is disabled; no IPv6 leak detected"})
    if local.get("dns_has_cn"):
        conclusions.append({"level": "bad", "text": "CN DNS resolver detected; location may be exposed"})
    elif local.get("dns"):
        conclusions.append({"level": "ok", "text": "No CN DNS resolver detected"})
    if pub_data.get("ok"):
        score = risk.get("score")
        if score is not None:
            if score < 30:
                conclusions.append({"level": "ok", "text": f"IP risk is low ({score}/100)"})
            elif score < 70:
                conclusions.append({"level": "warn", "text": f"IP risk is medium ({score}/100)"})
            else:
                conclusions.append({"level": "bad", "text": f"IP risk is high ({score}/100)"})
        elif not (pub_data.get("proxy") or pub_data.get("hosting")):
            conclusions.append({"level": "ok", "text": "IP has no proxy or hosting flags"})
        if proxy_detected and not any(hard_high.values()):
            conclusions.append({
                "level": "warn",
                "text": "IP marked as proxy/VPN - expected when you are tunneling; Claude anti-scraping may misclassify",
            })
    if tz.get("matched") is True:
        conclusions.append({"level": "ok", "text": "Timezone match"})
    elif tz.get("matched") is False:
        conclusions.append({"level": "bad", "text": "Timezone mismatch"})
    out["conclusions"] = conclusions
    if any(hard_high.values()):
        out["verdict"] = "high"
    elif proxy_detected:
        out["verdict"] = "proxy-in-use"
    else:
        out["verdict"] = "low"
    return out


def _utc_str(offset):
    total = int(offset.total_seconds())
    h, r  = divmod(abs(total), 3600)
    sign  = "+" if total >= 0 else "-"
    return f"UTC{sign}{h:02d}:{r//60:02d}"


def get_cli_tz_name():
    tz_env = os.environ.get('TZ', '')
    if tz_env:
        return tz_env, True

    if IS_WIN:
        try:
            r = subprocess.run(
                ['powershell', '-NoProfile', '-Command',
                 '[System.TimeZoneInfo]::Local.Id'],
                capture_output=True, text=True, timeout=3, encoding='utf-8',
            )
            win_id = r.stdout.strip()
            if win_id:
                return win_id, False
        except Exception:
            pass

    name = datetime.datetime.now().astimezone().tzname() or "Unknown"
    return name, False


# ── 主程序 ────────────────────────────────────────────────
def main():
    if len(sys.argv) > 1 and sys.argv[1] in ('--version', '-v', '-V'):
        from ipcheck import __version__
        print(f"ipcheck {__version__}")
        return

    if "--json" in sys.argv:
        import json as _json
        print(_json.dumps(collect_all(), ensure_ascii=False, indent=2, default=str))
        return

    # 同 collect_all：整轮定一次，三个请求共用。
    route = resolve_route()
    pub = get_public_info(route)
    pub_ok = pub.get("status") == "success"

    print(f"\n  {C.BOLD}ipcheck — 网络环境诊断工具{C.RESET}  "
          f"{C.GRAY}({platform.system()} / Python {platform.python_version()}){C.RESET}\n")
    tbl_top()

    # 本机网络
    tbl_row("局域网 IP", get_lan_ip())
    ipv6_addr = get_ipv6()
    ipv6_leaked = ipv6_addr is not None
    tbl_row("IPv6 地址", ipv6_addr if ipv6_leaked else warn("已禁用"))
    dns = get_dns_servers()
    if dns:
        tbl_row("DNS 服务器", dns_label(dns[0]))
        for d in dns[1:]:
            tbl_row("", dns_label(d))
    else:
        tbl_row("DNS 服务器", warn("获取失败"))
    dns_cn = any("(CN)" in KNOWN_DNS.get(d, "") for d in dns)

    tbl_sep()

    # 公网信息
    if pub_ok:
        pub_ip = pub.get("query")
        tbl_row("公网 IP",          pub_ip or bad("获取失败"))
        tbl_row("国家 / 省份",      f"{_val(pub.get('country'))} / {_val(pub.get('regionName'))}")
        tbl_row("城市",              _val(pub.get("city")))
        tbl_row("ISP(互联网服务商)", _val(pub.get("isp")))
        tbl_row("组织",              _val(pub.get("org")))
        pub_tz_name = pub.get("timezone")
        if pub_tz_name:
            zi = make_zone(pub_tz_name)
            if zi:
                off = datetime.datetime.now(zi).utcoffset()
                tbl_row("所处时区", f"{pub_tz_name}  ({_utc_str(off)})")
            else:
                tbl_row("所处时区", pub_tz_name)
        else:
            tbl_row("所处时区", _val(None))
    else:
        tbl_row("公网请求", bad(pub.get("message") or "未知错误"))

    tbl_sep()

    # 代理检测
    risk_score = None
    proxy_envs = get_proxy_envs()
    if proxy_envs:
        for k, v in proxy_envs.items():
            tbl_row(k, warn(v))
    else:
        tbl_row("环境变量代理", ok("未设置"))
    if pub_ok:
        tbl_row("IP 标记为代理", bad("是 ✗") if pub.get("proxy")   else ok("否 ✓"))
        tbl_row("机房 / 托管",   bad("是 ✗") if pub.get("hosting") else ok("否 ✓"))
        if (pub.get("hosting") or pub.get("proxy")) and pub_ip:
            probes = _collect_risk_probes(pub_ip, route)
            risk_result, risk_error = probes["risk"]
            if risk_error is None:
                risk_display, risk_score = risk_result
            else:
                risk_display = warn(f"查询失败（{risk_error}）")
            tbl_row("IP 风险查询",  risk_display)
            spam_lines, spam_error = probes["spam"]
            if spam_error is not None:
                spam_lines = [warn(f"查询失败（{spam_error}）")]
            tbl_row("垃圾滥用记录", spam_lines[0])
            for line in spam_lines[1:]:
                tbl_row("", line)

    tbl_sep()

    # 时区
    tz_matched = None
    cli_dt     = datetime.datetime.now().astimezone()
    cli_offset = cli_dt.utcoffset()
    tz_name, is_iana = get_cli_tz_name()
    tbl_row("CLI 时区", f"{tz_name}  ({_utc_str(cli_offset)})")

    pub_tz_name = pub.get("timezone") if pub_ok else None
    if pub_tz_name:
        pub_zi     = make_zone(pub_tz_name)
        pub_offset = datetime.datetime.now(pub_zi).utcoffset() if pub_zi else None

        if is_iana:
            tz_matched = tz_name == pub_tz_name
            match = ok("一致 ✓") if tz_matched else bad("不一致 ✗")
        elif pub_offset is not None:
            tz_matched = cli_offset == pub_offset
            if tz_matched:
                match = warn("UTC 偏移一致（建议设置 $TZ=IANA 名称精确比对）")
            else:
                match = bad("不一致 ✗（UTC 偏移不同）")
        else:
            match = warn("无法比对（tzdata 未安装？pip install tzdata）")
        tbl_row("时区一致性", match)

    tbl_sep()
    conclusions = []
    if ipv6_leaked:
        conclusions.append(bad("✗ IPv6 泄露，暴露真实地址"))
    else:
        conclusions.append(ok("✓ IPv6 已禁用，无泄露风险"))
    if dns_cn:
        conclusions.append(bad("✗ DNS 使用国内服务商，暴露真实位置"))
    elif not dns:
        conclusions.append(warn("- DNS 获取失败，无法评估"))
    else:
        conclusions.append(ok("✓ DNS 未检测到国内服务商"))
    if not pub_ok:
        conclusions.append(warn("- IP 信息获取失败，无法评估风险"))
    elif pub.get("proxy") or pub.get("hosting"):
        if risk_score is not None:
            if risk_score < 30:
                conclusions.append(ok(f"✓ IP 风险低（{risk_score}/100）"))
            elif risk_score < 70:
                conclusions.append(warn(f"! IP 风险中等（{risk_score}/100），建议关注"))
            else:
                conclusions.append(bad(f"✗ IP 风险高（{risk_score}/100），建议更换节点"))
        else:
            conclusions.append(warn("! IP 为机房/代理，未查到风险分数"))
    else:
        conclusions.append(ok("✓ IP 正常，无风险标记"))
    if tz_matched is True:
        conclusions.append(ok("✓ 时区一致"))
    elif tz_matched is False:
        conclusions.append(bad("✗ 时区不一致，建议调整"))
    else:
        conclusions.append(warn("- 时区无法比对"))
    has_bad = (ipv6_leaked or dns_cn
               or (risk_score is not None and risk_score >= 70)
               or tz_matched is False)
    tbl_row("结论分析", conclusions[0])
    for c in conclusions[1:]:
        tbl_row("", c)
    tbl_sep()
    if has_bad:
        tbl_row("综合结论", bad("⚠ 当前环境 Claude 使用高风险"))
    else:
        tbl_row("综合结论", ok("✓ 当前环境 Claude 使用低风险"))

    tbl_bot()

    if IS_WIN and _ZI is None:
        print(f"\n  {C.YELLOW}提示：pip install tzdata  （Windows 时区精确比对所需）{C.RESET}")
    if IS_WIN and not _COLOR:
        print(f"\n  提示：pip install colorama  （启用彩色输出）")
    print()
