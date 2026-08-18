# Service Operations Protocol

项目中"长期运行的服务"的**运维接口约定**——统一**生命周期脚本的命名与契约**（一套动词名 + 跨项目一致的行为保证）、**pull 的代码如何在运行服务上生效（收敛部署）**、**及服务失败时如何主动够到用户（故障告警，§6）**，让用户在任何项目里用同一套命令发现、部署、运维服务，并在服务出错时被及时告知。**Trust-the-LLM 优先**：给的是 WHY + WHAT + 契约，不是逐行模板。

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

**单向门**：手动 server 的运行环境若无持久载体（`.env`、start 脚本），就只存在于原进程（及多半已关闭的启动 shell）里——显式 export 的业务变量之外，还包括 `PYTHONPATH`、代理设置一类让程序能跑起来的定位变量——kill 即不可逆丢失，新进程起不来时已无处回读。所以 stop 之前先从原进程抓运行环境，且**抓取阶段不过滤**：警告或文档点名了某个变量，不等于只有那个变量重要；被过滤掉的不会以"缺失"的形式暴露，只会以"服务起不来"的形式暴露。environ 的读取载体按平台取：Linux 读 `/proc/<pid>/environ`（`tr '\0' '\n'` 拆行）；macOS 只有 `ps eww`，它对 Apple 平台二进制**静默输出零个环境变量**、还会把 argv 文本捞成假变量名——要抓真正的 server 进程而非 shell wrapper，且拿到的清单先与预期量级比对，空或异常短按未核实处理、**不得进入 stop**（失败与成功在此同形）。清单与取值的脱敏两步走见 `evidence-sufficiency.md` 的凭据回显条。抓取是一次性的过门动作：抓到的环境随即落回该服务的持久启动载体（start 脚本 / gitignored `.env`），让下次 make-live 不再依赖原进程——这道门从此不复存在，也回到「约定」的 `运行态 == repo 态`。

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

**判据**：空闲时持续吃 non-trivial 资源 **且** 非每机必需 → **可选服务**，必须按本节门控。空闲近零占用的轻量周期任务（cron / 周期 launchd）、每机普适的服务 → 默认不门控、随 install.sh 装；仓库可统一约定把它们也纳入门控（如一个全局 opt-in 开关覆盖全部后台服务），此时同样遵循本节三态收敛。判据由服务作者按 §3.5 作者自检 的方式自评。

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
- **故障告警**（§6）——**若该服务会告警**（是否需要按 §6.1 判据）：述其路径（in-service emit 还是靠外部探针），让用户知道"出错时会不会有人喊我"；§6.1 判为无需告警的服务免此项
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
| 故障告警链路新增 / 改（§6） | README 服务章节 / operations 标注该服务是否告警、in-service emit 还是靠外部探针、dedup-key；repo own 新增 in-service emit 时确认走 `im-notify --alert --dedup-key`（非手搓 webhook）；vendored→标注上游原生告警接口、不包 im-notify（§6.5） |
| 移除服务 | 两处删条目 |
| 部署方式变化 | 更新 supervisor / 脚本标注 |
| 裸命令运维 | 提示该换成规范脚本（仅 repo own 的服务）；服务内手搓 webhook 告警提示改走 `im-notify --alert`（§6.3） |

sync-docs 审查侧的 flag 条件见 `docs-review-principles.md` §5（服务覆盖、裸命令该换脚本；vendored 原生接口不算缺陷）。

doc-updater 报告缺失的脚本，**不自动写脚本**（生成代码超出文档范畴）。

---

## 6. 故障告警（push 可观测）

§3 的 `status` 是 **pull** 可观测——你主动跑才看到。但长期服务会在你不看时失败，需要 **push**：失败主动够到你。本节是 `status` 契约的 push 对偶，让"造服务"这件事默认就带上"它坏了我怎么知道"，而非每次等用户提。

本节管**投递与去重契约**（怎么发、发不发、别刷屏）；告警的**设计质量**——值不值得 page、多严重、消息说什么、多告警要不要合并——见 `alerting-review-principles.md`。构建或审核告警时两档都要过（审核用 `/custom:review-alerting`）。

### 6.1 作者自检：这个服务需要 push 告警吗

判据：它失败时，用户会及时知道吗？不会 → 需要 push 告警。空闲无害、失败也无所谓的服务不强求。判据由服务作者按 §3.5 作者自检 的方式自评——造服务时就问，别留到出过一次事故才补。

**自检的产出是一个决定，不是一句话。** 三种合法产出，没有第四种"记下来就算"：

1. **实现**——结论为"需要"且本次范围允许，按 §6.2 选机制落地。
2. **带归属的待办**——确实要推迟，写成 **git-tracked** 的一条（项目 `docs/issues/` 或该服务 README 服务章节的 TODO），指名仓库与负责人。**session 内的 todo list 不算**：它与"结论已记录"持久度等价，挡不住这条规则要挡的事。
3. **迁移**——服务**已有**告警，而本次改动动了它所依赖的身份锚点（launchd Label、服务名、端口、`--dedup-key`）。此时要做的不是"选机制并实现"，而是同步更新 supervisor 注册名与 dedup-key，并确认旧 key 下未消解的告警不会永久悬挂。改标识符的服务基本都已上线、已有告警，这一档才是那条触发条件最常命中的场景。

只写结论不落其中任一种，等于把一个已知会静默失败的服务照常交付出去——那正是本节要挡的事。

**什么时候要跑这个自检**：新建长期运行的服务（边界见 §1），或**改动它的失败面**——判据是这次改动之后是否多出或改变了一种会独立失败的情形。**不问它可不可见**：可见性正是本节要判的，把它放进触发条件就要求作者先做出这个判断，等于把闸门锁在闸门后面。

| 属"改动失败面"（示例，非穷举） | 不属 |
|---|---|
| 新增外部依赖、新增独立处理单元 | 措辞、内部日志文案 |
| 改重试与超时、改生命周期、改降级路径 | 进程内变量重命名 |
| 改变错误传播路径 | 不改变错误传播的内部重构 |
| 改动承载身份或生命周期语义的标识符（launchd Label、服务名、端口） | |

### 6.2 两类失败 → 两种机制（关键）

"服务出错"其实是两类，**探测位置不同**，别指望一种机制够到另一类：

| 失败类 | 谁能看见 | 机制 |
|---|---|---|
| 崩溃 / 进程死 / 卡死 / 崩溃环 | **外部探针**——进程自己已经死了，喊不出话 | launchd 服务：复用 fleet 级 watchdog（system-config `watchdog.sh` 已在监所有 launchd user agent 的崩溃环 / 日志暴涨 / 高 CPU），注册为它看得见的 supervisor 作业即被覆盖。cron / 非 launchd 的进程死 watchdog 看不全——用 `run-or-alert`（§6.3）包住命令，非零退出即告警 |
| 应用级健康失败——进程活着但活儿失败（抓取 0 条、API 全 500、pipeline 产出空、额度耗尽） | **只有服务自己的代码** | **in-service emit**：在失败路径调 `im-notify --alert`（§6.3） |

外部探针抓「死没死」，in-service emit 抓「活着但错了」。后者是造服务时最容易漏的——它要求你写业务逻辑时主动想到"这个失败外面看不见，得自己喊一声"。

### 6.3 发送走 `im-notify` 家族（复用 infra，别手搓 webhook）

两条复用入口，别每个项目重写 webhook POST（源 `im-notify/`，均已在 PATH）。两者都走 `im-notify --alert`，须先在 `~/.claude/.env` 配好 `FEISHU_GENERAL_ALERT_WEBHOOK`（与 notification 通道分开），否则 exit 2 不发：

- **in-service emit**（应用级健康失败）：失败路径直接调 `im-notify --alert --dedup-key <svc>`。`--dedup-key` 按 key 下文本精确匹配去重（崩溃环只告警一次，不刷屏）；精确匹配语义与易变指标处理见 `im-notify/README.md` § Two modes
- **cron / 非 launchd 的进程死**：用 `run-or-alert --key <svc> -- <命令>` 包住——命令非零退出即告警、退出 0 自动复位使复发能重告警，原退出码透传。这是崩溃类里 watchdog 看不全那部分的复用件；行为细节见 `im-notify/README.md` § run-or-alert

### 6.4 告警值不值得发（纪律）

**状态变化才告警**，非每次 error。去重由 `--dedup-key` 承担，但作者仍要选对 key 的粒度：一个 key = 一个"问题身份"。同一问题反复出现 = 一条；恢复了想重新感知，发一条不同文本（如 `recovered`）即可。滥发会被用户调成静音——那时告警等于没有。

### 6.5 Vendored 例外

与 §1 一致：上游自管的服务只文档化其原生告警接口，不在仓库里包 `im-notify` 调用（包装会被上游更新覆盖）。

**记录在哪**：服务的告警路径（有没有、in-service 还是靠探针、dedup-key）是 [User] 运维信息，落 README 服务章节 / operations（落点结构归 docs-org，见 §4、§5）。
