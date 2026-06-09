# Network Masquerade Remediation Runbook

本机网络伪装加固手册。当 `ip-check` / tt-web `/network` 判定 `verdict: high` 时，按本手册逐项定位根因并修复。macOS 专用。

> **范围**：让本机网络对外呈现与代理出口一致的地区，避免 IPv6 / DNS / 时区泄漏真实位置。检测由 `ip-check` 负责；修复多为侵入式系统变更，故为**手动 runbook**——其中最关键的 DNS 根因在代理客户端的 GUI 里，无 CLI / 无配置文件，无法脚本化（见末节）。

## 0. Detect — 先看清现状

```bash
ip-check            # 彩色表格
ip-check --json     # 结构化输出（与 tt-web /api/network 同源）
```

读 `verdict` 与 `conclusions`；下面每个 `bad` 结论对应一节。

> `install.sh`（经 `tt-web/install.sh`）会在安装末尾自动跑一次 `ip-check`，仅当 `verdict: high` 时打印 `bad` 结论并指回本手册；环境干净则静默，且永不中断安装。

辅助——定位**活动网络服务名**（多数 `networksetup` 命令要用，随机器/连接而变，勿写死）：

```bash
iface=$(route -n get default | awk '/interface:/{print $2}')
svc=$(networksetup -listnetworkserviceorder | awk -v d="$iface" '
  /^\([0-9]+\)/ { name=substr($0, index($0,") ")+2) }
  index($0,"Device: " d ")") { print name; exit }')
echo "active service: $svc  (iface $iface)"
```

## 1. `IPv6 leak detected; real address is exposed`

| | |
|---|---|
| 根因 | 物理网络（蜂窝/热点等）经 SLAAC 下发运营商 IPv6；代理只隧道 IPv4，IPv6 绕过隧道直连，暴露真实地址 |
| 确认 | `ip-check --json` → `local.ipv6_leaked: true`；`ifconfig "$iface" inet6` 见全局 `autoconf` 地址 |
| 修复 | `sudo networksetup -setv6off "$svc"` |
| 验证 | ip-check → `IPv6 is disabled; no IPv6 leak detected` |
| 回滚 | `sudo networksetup -setv6automatic "$svc"` |

## 2. `CN DNS resolver detected; location may be exposed`

先定位来源（关键——决定改哪里）：

```bash
scutil --dns | sed -n '/^DNS configuration$/,/scoped/p' | grep -A6 "resolver #1"
echo 'show State:/Network/Global/DNS' | scutil   # 看 __CONFIGURATION_ID__ 指向哪个 service
```

| 来源 | 修复 |
|---|---|
| **代理客户端隧道下发**（最常见；`State:/Network/Global/DNS` 的 `__CONFIGURATION_ID__` 指向其 `utun` 服务，`SupplementalMatchDomains:[""]` 即 match-all 覆盖一切） | **手动 GUI**：在代理客户端的 DNS 设置里把 IPv4/IPv6 主备 4 个解析器改成非 CN（`8.8.8.8` / `8.8.4.4`、`2001:4860:4860::8888` / `::8844`）→ 保存。**无法脚本化**（无 CLI/配置文件） |
| 底层网络 DHCP DNS（代理未劫持时） | `sudo networksetup -setdnsservers "$svc" 8.8.8.8 8.8.4.4`（兜底；若代理在 match-all 劫持则会被其覆盖） |

验证：ip-check → `No CN DNS resolver detected`。

> **「假绿」陷阱**：若另一台机器同样配置却显示 OK，很可能是 Tailscale 的 `100.100.100.100` 在服务顺序竞争里偶然排到代理前面、把 CN 信号挡住——**底层 DNS 仍走 CN**。务必核对真实解析路径（`scutil --dns` 主解析器 + 代理服务的 DNS），别只信 ip-check 最前面那个解析器 IP。

## 3. `Timezone mismatch`

| | |
|---|---|
| 根因 | 代理出口节点地区时区 ≠ 本机时区。ip-check 的 `cli_tz` 取自 **tt-web 进程的 `TZ` 环境变量（启动时快照）**，无则回落系统时区。常见两因：①tt-web 老进程攥着旧 `TZ`；②时区与节点地区确实不符 |
| 确认 | `tz_check.matched: false`；比对 `tz_check.cli_tz` vs `public.timezone` |

修复——把三层都对齐到**出口节点地区**（把下方 `<TZ>` 换成如 `Asia/Taipei`、`America/Los_Angeles`）：

```bash
# (a) shell 层：写 .zshenv（不是 .zshrc！见 Gotchas）
grep -q 'export TZ=' ~/.zshenv 2>/dev/null || echo 'export TZ="<TZ>"' >> ~/.zshenv

# (b) 系统层（浏览器/JS 指纹的权威来源）：关自动时区 + 设定
sudo defaults write /Library/Preferences/com.apple.timezone.auto Active -bool false
sudo systemsetup -settimezone "<TZ>"

# (c) 让 ip-check 重读：用正确 TZ 重启 tt-web
TZ="<TZ>" ./tt-web/tt-web stop && TZ="<TZ>" ./tt-web/tt-web start
```

验证：ip-check → `Timezone match`。回滚自动时区：`sudo defaults write /Library/Preferences/com.apple.timezone.auto Active -bool true`。

> **耦合警告**：时区与出口节点地区绑定。把代理切到别国节点后，公网时区随之变，须重新对齐 (a)(b)(c)，否则 `Timezone mismatch` 复现。DNS、IPv6 不受节点地区影响，无需重做。

## Gotchas（本仓踩过的非显然坑）

- **`.zshrc` vs `.zshenv`**：`.zshrc` 只对**交互式** shell 生效；`.zshenv` 对**所有** zsh（含脚本、被非交互拉起的进程）。环境变量（含 `TZ`）应放 `.zshenv`，否则 tt-web 这类非交互进程读不到——这正是本仓时区 bug 的根因。
- **tt-web 缓存 `TZ`**：`cli_tz` 来自 tt-web 进程**启动那刻**的 `TZ` 快照；改完 `TZ` / `.zshenv` 必须重启 tt-web 才生效。
- **代理 match-all DNS 压过 macOS 层**：`networksetup -setdnsservers` 改的是接口 DNS，会被代理隧道的 match-all `NEDNSSettings` 覆盖——CN DNS 只能在代理 app 里改。
- **系统时区 vs `TZ` 环境变量**：浏览器/JS 读**系统时区**（`/etc/localtime`）；命令行工具读 `TZ`。两者都对齐才彻底。
- **`systemsetup` 的 `Error:-99 ... InternetServices.m`**：无害噪音，每次都打印，与成败无关；以 `Time Zone: <TZ>` 行为准。

## 为什么是手动 runbook 而非 `install.sh`

1. **根因不可脚本化**：CN DNS 的真因在代理客户端 GUI（服务器态、无 CLI/配置文件），脚本碰不到，只能检测到后打印手动指引。
2. **侵入式 & 有状态**：关 IPv6 / 改 DNS / 改系统时区是对实时系统的侵入式变更，且依赖当前活动服务、出口节点地区等情境——不该在 `install.sh`（fresh-Mac 无人值守）里跑。**检测**工具由 `tt-web/install.sh` 安装；**修复**按需照本手册手动执行。
