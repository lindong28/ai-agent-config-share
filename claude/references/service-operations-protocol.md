# Service Operations Protocol

项目中"长期运行的服务"的**运维接口约定**——统一**生命周期脚本的命名与契约**（一套动词名 + 跨项目一致的行为保证），让用户在任何项目里用同一套命令发现、部署、运维服务。**Trust-the-LLM 优先**：给的是 WHY + WHAT + 契约，不是逐行模板。

**与 `docs-organization-protocol.md` 的边界**：本协议是**脚本接口轴**——脚本怎么命名、什么契约、vendored 怎么办；服务该进哪些文档（README 服务章节、operations/services.md）的**结构**归 docs-org，本协议 §4 只提服务特定要求并指过去。

**消费者**：[User]——拿到源代码后需要部署、运维服务的人。

被 `docs-organization-protocol.md`（§4.1、§4.10）、`doc-updater` agent、`docs-review-principles.md`（P5）共同引用。

---

## 1. 适用范围

**服务** = 拿到源代码后**长期在后台运行**的东西：launchd / systemd / cron 守护的进程、手动起的常驻 server、容器。一次性 CLI、npm/brew 包、构建产物**不算**——空闲不占资源、在脚本里直接可见。

判据：不主动调用时它是否仍在运行 / 占资源？是 → 服务，受本协议管辖。一个项目可有多个服务。

**Vendored 例外**：上游自管的服务（有自己的发版周期和运维接口，如 vendored skill、第三方 daemon）只**文档化其原生接口**（README + operations/services.md），不在仓库里加包装脚本——包装会被上游更新覆盖，且为外部项目维护转接层是负担。只有仓库自己 own 运维 wiring 的服务（自己写的 install.sh / plist / 启动逻辑）才落 §3 脚本。

---

## 2. 核心原则：操作名即接口

同一个运维操作，在**所有项目**里用**同一个动词名**触发。在一个项目学会的命令，换项目原样可用——不必记"这个项目的 status 怎么查"。

这条高于实现差异：服务是 cron、launchd 还是手动 server，`status` 永远叫 `status`。**统一的是动词名（用户的接口），不是实现。**

---

## 3. 生命周期脚本

### 3.1 命名与位置

每个操作一个独立动词脚本，**与项目的 `install.sh` 同级**（继承既有 install.sh 放置惯例——install.sh 在哪，其它就在哪）。

| 脚本 | 操作 |
|---|---|
| `install.sh` | 一次性部署：幂等装依赖、注册 supervisor（launchd/cron/systemd）并启动 |
| `uninstall.sh` | 反向：注销 supervisor、停服务。保留数据/日志，**不**删源码与配置注册表 |
| `start.sh` | 把已安装的服务拉起（不重新部署） |
| `stop.sh` | 停掉运行中的服务，保留安装状态（下次 start 直接拉起） |
| `status.sh` | **只读**面板：是否已装/加载、是否在跑（pid）、最近日志 |

### 3.2 实现适用的子集

**不强求写满**——同一操作用同一名字即可：

| 服务形态 | 实现 | 说明 |
|---|---|---|
| cron 定时任务 | install / uninstall / status | install 即注册调度，无独立 start/stop |
| 手动常驻 server | start / stop / status | 无 supervisor，无 install |
| launchd/systemd 守护 | install / uninstall / status（+按需 start/stop） | 需"临时停/起而不卸载"才加 start/stop：stop=bootout（保留 plist），start=bootstrap |

### 3.3 各脚本的契约

用户敢盲跑的前提——跨项目可预期的行为：

| 契约 | 适用 | 含义 |
|---|---|---|
| 幂等 | install / start / stop / uninstall | 重复跑不报错、不重复注册；已是目标态则 no-op |
| 只读 | status | 永不改状态；服务没装也不报错，打印"未安装"提示 |
| 可观测 | 全部 | 每个操作打印 ✓/⚠ 结果；install/start 末尾给验证命令 + 日志位置 |
| 容错 | uninstall / stop / status | 目标不存在时优雅退出（"nothing to remove"），不抛错 |
| 自定位 | 全部 | 从脚本自身路径解析项目根，可从任意 CWD 调用 |

### 3.4 多服务：可选的服务参数

项目有多个子服务时，脚本接受**可选的服务名位置参数**，操作单个；省略则作用于全部。

```bash
./status.sh                # 所有服务，一行一个
./start.sh <service>       # 只起这个
./uninstall.sh <service>   # 只卸这个
```

---

## 4. 文档要求

### 4.1 README 服务章节 [User]

有服务的项目，README 必须有**专门的服务章节**（`## 服务` / `## Services`），让用户一眼看到：

- **有哪些服务** + 各自作用（一句话）
- **怎么部署 / 起停 / 查状态 / 移除**——指向该服务的运维入口（repo own→§3 脚本，取实现子集；vendored→上游原生接口）
- **重内容下沉**——单服务运维细节多到会撑大 README 时，移到 `docs/operations/`，README 只留清单 + 运维入口 + 一条引用链接

判据：用户读完这节，不读源码就知道"在跑什么、怎么起停查"。骨架见 `docs-format-templates.md` §4.1。

### 4.2 docs/operations/ [User]

服务运维总览落在 `docs/operations/`（见 `docs-organization-protocol.md` §4.10）。`services.md` 每个服务标注其运维入口（repo own→生命周期脚本；vendored→原生接口），把"现状快照"和"怎么操作"连起来。模板见 `docs-format-templates.md` §4.10。

---

## 5. 同步触发（Enforcement）

服务的**新增 / 移除 / 部署方式变化**（及裸命令运维）触发文档与脚本同步。

| 触发 | update-docs（写） |
|---|---|
| 新增服务 | README 服务章节 + operations/services.md 加条目；提示补齐运维入口（repo own→生命周期脚本；vendored→确认原生接口已文档化） |
| 移除服务 | 两处删条目 |
| 部署方式变化 | 更新 supervisor / 脚本标注 |
| 裸命令运维 | 提示该换成规范脚本（仅 repo own 的服务） |

review-docs 侧的 flag 条件见 `docs-review-principles.md` §5（服务覆盖、裸命令该换脚本；vendored 原生接口不算缺陷）。

doc-updater 报告缺失的脚本，**不自动写脚本**（生成代码超出文档范畴）。
