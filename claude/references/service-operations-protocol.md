# Service Operations Protocol

项目中"长期运行的服务"的**运维接口约定**——统一**生命周期脚本的命名与契约**（一套动词名 + 跨项目一致的行为保证）、**及 pull 的代码如何在运行服务上生效（收敛部署）**，让用户在任何项目里用同一套命令发现、部署、运维服务。**Trust-the-LLM 优先**：给的是 WHY + WHAT + 契约，不是逐行模板。

**与 `docs-organization-protocol.md` 的边界**：本协议是**脚本接口轴**——脚本怎么命名、什么契约、代码改动怎么生效、vendored 怎么办；服务该进哪些文档（README 服务章节、operations/services.md）的**结构**归 docs-org，本协议 §4 只提服务特定要求并指过去。

**消费者**：[User]——拿到源代码后需要部署、运维服务的人。

被 `docs-organization-protocol.md`（§4.1、§4.11）、`doc-updater` agent、`docs-review-principles.md`（P5）共同引用。

---

## 1. 适用范围

**服务** = 拿到源代码后**长期在后台运行**的东西：launchd / systemd / cron 守护的进程、手动起的常驻 server、容器、开机自启项（login item / 自启 daemon）。一次性 CLI、npm/brew 包、构建产物**不算**——空闲不占资源、在脚本里直接可见。

判据：不主动调用时它是否仍在运行 / 占资源？是 → 服务，受本协议管辖。一个项目可有多个服务。

**Vendored 例外**：上游自管的服务（有自己的发版周期和运维接口，如 vendored skill、第三方 daemon）只**文档化其原生接口**（README + operations/services.md），不在仓库里加包装脚本——包装会被上游更新覆盖，且为外部项目维护转接层是负担。只有仓库自己 own 运维 wiring 的服务（自己写的 install.sh / plist / 启动逻辑）才落 §3 脚本。own wiring 是**连续光谱**——半 vendored 服务（上游代码 + 仓库补丁）只 own 一部分 wiring，其生命周期仍走上游原生入口而非仓库包装（见 §3.5）。

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
| `install.sh` | 一次性部署 **+ 幂等收敛入口**（即 §3.5 的 make-live 入口）：幂等装依赖、注册 supervisor（launchd/cron/systemd）并启动；再跑一次把运行中服务收敛到 repo 态（§3.2 无 install 的纯手动 server 除外，其 make-live 入口是 `stop && start`） |
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

### 3.5 收敛部署（让代码变更生效）

**问题**：改了某服务的代码、`git pull` 之后，新代码怎么真正在运行中的服务上生效？逐次人肉判断"这回要不要 build / reload / restart"既易漏又不跨项目一致。

**约定**：`git pull && ./install.sh` 是统一的 make-live 入口（§3.2 中无 install 的纯手动 server 例外：其 make-live 入口是 `stop && start`）。install 是**声明式收敛**（类 `make` / `terraform apply`）：再跑一次 = 把运行中的服务收敛到 repo 当前声明的状态，而非新增一个 "redeploy" 动词。这是 §3.3「幂等」契约的延伸——从"重复跑不报错"到"重复跑使运行态 == repo 态"。

**作者自检**：让"再跑 install"真的让 pull 的代码生效——验收标准是「约定」那句 `运行态 == repo 态`。下面三个因素是收敛代码时**最常漏的轴**，不是全集：新服务的 installer 每个先问"我的服务在这一维属于哪一类"再落契约。若服务还持有**代码之外的持久状态**（DB schema、磁盘配置格式），收敛代码 ≠ 收敛数据，作者须自行补迁移——三因素不覆盖它。验收回到 `运行态 == repo 态`，不是勾完三格。

| 因素 | 作者要问 | 契约 |
|---|---|---|
| **传播** | 运行时从哪里读它要跑的东西（脚本 / 二进制 / 镜像 / supervisor 定义）？ | 优先 symlink→repo，`git pull` 即就位、make-live 入口无需额外动作；若运行时读的是拷贝或再生成产物（unit 拷进 `/etc`、容器镜像、从 env 渲染的 plist），make-live 入口须在每次收敛时刷新它 |
| **构建** | 源码与运行物之间有无编译 / 打包步骤（TS→dist、镜像、二进制）？ | 无（解释型脚本）→ 跳过；有 → make-live 入口须保证**源码变更**触发重建。重建尽量交服务**自身的 build 机制**（如 `start` 内置的 mtime rebuild），make-live 入口只负责**触发**它，不另造一套 build 门控（双门控重复触发、易漏依赖）；且与三方依赖升级的 consent 门控**解耦**——repo 自身源码无条件应用，三方版本不顺带 bump |
| **生命周期** | 进程会自己读到新代码吗？ | 周期 / 一次性服务（cron、launchd 定时）下次 re-exec 自动读新代码——**前提是传播因素已让代码就位**（拷贝 / 再生成产物否则 re-exec 仍读旧物）；make-live 入口只需在 supervisor 定义（plist / unit / crontab）变更时重载它（supervisor 缓存已加载的定义副本，定义变更后须显式 reload——pull 不自动生效；具体命令按 supervisor 而定）；常驻进程（手动 server、daemon、容器）在内存里持有旧代码，make-live 入口须在代码变更后 restart 它 |

**半 vendored 服务**（上游代码 + 仓库补丁，如带 patch 的 skill）的生命周期走其**原生入口**（如 skill 的 `daemon.sh stop/start`，其 start 顺带 rebuild + 从 env 再生成 supervisor 定义），install 只**调用**该入口、不在仓库里包装它——包装会被上游更新覆盖、与之打架。

**记录在哪**：服务的 make-live 路径是 [User] 运维信息，落 README 服务章节 / operations（落点结构归 docs-org，见本协议 §4、§5）。

### 3.6 可选服务（opt-in 门控）

**问题**：有的服务**无人主动使用时仍持续吃 non-trivial 资源**（RAM/CPU/GPU/磁盘），且**非每台机都需要**（典型：本地 LLM runtime、推理服务）。每台机的 install.sh 都无脑装它 = 凭空浪费；但要用户记住"这台机该装哪些"也不现实。

**判据**：空闲时持续吃 non-trivial 资源 **且** 非每机必需 → **可选服务**，按本节门控。空闲近零占用的轻量周期任务（cron / 周期 launchd）、每机普适的服务 → 不门控，随 install.sh 默认装。判据由服务作者按 §3.5 作者自检 的方式自评。

**收敛规则：installed-state 即意图**——不另立"想装哪些"的清单或 marker，服务**当前是否已安装**就是这台机的意图来源（声明式系统读 actual state 的手法）。三态如下：

| 这台机现状 | install.sh 对该可选服务 |
|---|---|
| **已安装** | 照 §3.5 收敛到 repo 态，与普通服务无差别 |
| **未安装**，本次无显式 opt-in | 保持未安装、不主动装上（未安装即自持久的 opt-out） |
| 本次**显式 opt-in**（`--all`/env，或交互提示答 yes） | 装上并启动；此后它已安装，落入第一行 |

**opt-in 两个入口**：

- **非交互覆盖**（env / flag，如 `--all`）：给"知道自己要什么"的用户和自动化一把全开；沿用"非 TTY 默认关、env 显式覆盖"的约定（与本仓库 `UPDATE_EXISTING` 同构）。
- **交互提示**：意图缺省时的 intake，**必须 gate 住，使 routine 收敛重跑不重复追问**——例如只在本机首次 install 触发，或纯靠 installed-state 让"yes"自消解（落入三态表"已安装"行），任一达成即可。**非 TTY 一律跳过**（收敛要可盲跑）。

本节是 §3.3「幂等」契约对可选服务的细化：从"重复跑不报错"到"重复跑不改变这台机的服务集合，除非显式 opt-in"。与 §3.5 互补——§3.5 管"已在的服务怎么吃到新代码"，本节管"这台机到底装哪些服务"。

**记录在哪**：可选服务的 opt-in 入口（默认不装 + 开启命令/env）是 [User] 运维信息，落 README 服务章节（见 §4.1、§5）。

---

## 4. 文档要求

### 4.1 README 服务章节 [User]

有服务的项目，README 必须有**专门的服务章节**（`## 服务` / `## Services`），让用户一眼看到：

- **有哪些服务** + 各自作用（一句话）
- **怎么部署 / 起停 / 查状态 / 移除**——指向该服务的运维入口（repo own→§3 脚本，取实现子集；vendored→上游原生接口）
- **可选服务**（§3.6）额外标注：默认不装、用什么 flag/env/命令开启——让用户知道这台机怎么把它开启
- **重内容下沉**——单服务运维细节多到会撑大 README 时，移到 `docs/operations/`，README 只留清单 + 运维入口 + 一条引用链接

判据：用户读完这节，不读源码就知道"在跑什么、怎么起停查"。骨架见 `docs-format-templates.md` §4.1。

### 4.2 docs/operations/ [User]

服务运维总览落在 `docs/operations/`（见 `docs-organization-protocol.md` §4.11）。`services.md` 每个服务标注其运维入口（repo own→生命周期脚本；vendored→原生接口），把"现状快照"和"怎么操作"连起来。模板见 `docs-format-templates.md` §4.11。

---

## 5. 同步触发（Enforcement）

服务的**新增 / 移除 / 部署方式变化**（及裸命令运维、代码改动如何生效）触发文档与脚本同步。

| 触发 | sync-docs（写） |
|---|---|
| 新增服务 | README 服务章节 + operations/services.md 加条目；提示补齐运维入口（repo own→生命周期脚本；vendored→确认原生接口已文档化）；若是 §3.6 可选服务，另标注其 opt-in 入口（默认不装 + 开启命令） |
| make-live 路径（代码改动如何生效） | README 服务章节 / operations 必述该服务的 make-live：再跑 `./install.sh`（无 install 的手动 server→stop && start）后新代码经传播 / 构建 / 生命周期哪条路到达运行态（见 §3.5）；repo own 与 vendored 都要说明；若服务持代码之外的持久状态（DB schema / 磁盘配置），另述其迁移路径（见 §3.5） |
| 移除服务 | 两处删条目 |
| 部署方式变化 | 更新 supervisor / 脚本标注 |
| 裸命令运维 | 提示该换成规范脚本（仅 repo own 的服务） |

sync-docs 审查侧的 flag 条件见 `docs-review-principles.md` §5（服务覆盖、裸命令该换脚本；vendored 原生接口不算缺陷）。

doc-updater 报告缺失的脚本，**不自动写脚本**（生成代码超出文档范畴）。
