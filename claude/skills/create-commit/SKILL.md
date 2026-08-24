---
name: create-commit
description: >-
  Create a git commit from working-tree changes — reviews the diff and
  untracked files, checks staging scope and identity, drafts a
  conventional commit message, then commits. Use when the user asks to
  commit (提交改动 / commit this), when a command needs to commit on the
  user's behalf, or as the default wrap-up once authorized changes pass
  their review gate and the repo's own policy already permits local
  commits. The steps below ask the user where they call for it — an
  unresolvable author identity, an uncertain staging boundary, or a
  policy-level exception this skill surfaces once Step 1 reads the
  repo state (a project rule withholding commit authority, a landing
  spot on a shared main/master; CLAUDE.md owns those rules and their
  options). None of that is routine per-commit approval. Its product is a
  new commit; the one commit it will amend is the one it just made, and
  the amend section states the preconditions binding any amend.
---

# Create Commit

审查 working tree 改动、生成 commit message、执行 commit。流程内有若干处要求向用户确认（身份判不准、staging 归属不确定、范围冲突），逐处写在该步。**共享 tip 落点与项目规则收紧的裁决规则与选项归上位政策**（`~/.claude/CLAUDE.md`），但**触发它们的事实由第 1 步显式取得**（worktree 清单、写入者登记、目标仓自己的 CLAUDE.md/AGENTS.md）——所以本 skill 负责在那一步发现后**向上升级**（按该政策把落点交用户），不是假定调用方进来前已经判完：直接调用本 skill、或调用方没复制那段预检时，那个假定会让条件被发现却无人处置；**不含**「每次 commit 前再问一遍要不要 commit」——那一层由 `~/.claude/CLAUDE.md`「Git Push 需显式许可」的常设请求授权，除非本仓规则另有收紧。

## 流程

1. **了解当前状态**：`git branch --show-current`、`git status --short --untracked-files=all`、`git diff --stat`、`git log --oneline -5`。读核心 diff 理解改动性质。

   **同一步另取两样上位政策要用的事实**——它们决定要不要向上升级，而 `git status` 干净时它们照样可以成立：

   ```sh
   git worktree list                                   # 共享拓扑
   cat "$(git rev-parse --path-format=absolute --git-common-dir)"/agent-writers/*.json
   sed -n '/[Cc]ommit/,+3p' CLAUDE.md AGENTS.md 2>/dev/null   # 读正文，不是查文件名
   ```

   前两条判「这个 repo 此刻有没有别的决策者」，第三条判「本仓有没有收紧 commit 授权」。**两者都不是 `git status` 看得见的**：另一个 worktree 里的活动不会出现在本工作树的状态里，项目规则更不是 repo state。

   三条各有一个**读不到就等于没读**的坑，都实测踩过：

   - **写入者登记的载体是 common-dir 下的 `agent-writers/`**（协议见 `concurrent-plan-isolation.md`），不是仓根的 `.writers/`——后者在本仓根本不存在，那条命令的输出与「读到了但没人登记」完全一样。`--path-format=absolute` 也不可省：不带它时 linked worktree 里返回相对路径，按 cwd 拼接会落到别处，而跨 worktree 可见性正是换这个载体的全部理由。
   - **登记存在 ≠ 有活写入者**：条目要按其 PID / fingerprint 过活性校验，陈旧条目会让你把一次干净的提交误判成冲突。**本 session 自己的登记也在那个目录里**，别把它数成对手方。
   - **政策要读正文，不是查文件名**：`ls CLAUDE.md AGENTS.md` 在「本仓允许自主 commit」与「本仓要求逐次询问」两种情况下输出**逐字相同**。

   取到之后按 `~/.claude/CLAUDE.md`「Git Push 需显式许可」里那两处例外处置——落点交用户或按项目规则走，本 skill 不自行裁决那两件事。

   `--untracked-files=all` 不是可选的写法：默认输出把未跟踪目录**折叠成一行**（实测同一目录树下的两个新文件，只显示 `?? sub/`）。于是下一步的 lens 会被施加在"目录"这个容器上，而它的判据通篇是按**文件**写的——判断单元由 git 的显示行为决定，而不由 lens 的语义决定。实测代价：一个被折叠成一行的目录里混着一整套可复用工具链，整体判为中间产物排除掉。

   修不掉的折叠是**内嵌 git 仓库与 submodule**：`-uall` 对它们照样只出一行（`?? nested/`、` M sm`），`--ignore-submodules=none` 也一样。而内嵌仓库恰好最容易命中下一步 lens 的第一条（第三方 / vendor 快照）——遇到就单独进去看，别照着那一行判。

   同时核实**将写进本次 commit 的作者身份**：读 `git config user.name` 与 `git config user.email` 本身——**不要拿 `git log` 的历史作者代替**。历史作者是代理判据：连续多个 commit 用错身份时它已被同一个错值填满、会自洽地"通过"，多人仓库里它又每次都与你不同、只会制造误报；两种情况下它的输出在身份对与错时都不可区分。取到值后与该仓库预期的身份核对（remote 主机与组织、既有协作者的邮箱域、用户此前的交代）。不一致或判断不了就停下问用户，不要先提交再说：身份错在本地还能 amend，push 之后就是不可逆的公开归属错误，而 agent 侧全程零反馈信号——commit 成功、测试全绿、review gate 照过。多仓库、或公司与个人机器混用时尤其容易发生。

2. **决定 staging 范围**：

   | 来源 | 范围 |
   |---|---|
   | **Default**（用户直接调 skill 无额外说明） | 已 tracked 文件的所有修改 + 经下方 lens 筛选过的 untracked 文件 |
   | **User override**（用户调用时给出额外说明） | 按用户说明（如"只 stage X 和 Y"、"不要包含 Z"），优先于 default |
   | **Caller override**（上层 command / skill 在 prompt 里指定 scope） | 按 caller 指定，优先于 default；和 user override 同时存在时 caller 描述应自洽，不一致先停下问用户 |

   **Untracked 判断 lens**（仅在 default 模式下应用）：内容可从外部来源复现、或生命周期局限于单次 session 的文件通常不该 track。常见类型：
   - 第三方文档 / vendor 快照（记 URL + 版本号即可）
   - Session 过程日志（洞察应已提炼到持久文件如 issues）
   - Cache / 临时目录（.cache/、node_modules/）
   - Secrets / credentials

   判断不确定时用 `AskUserQuestion` 确认；无法 ask 时排除不确定的 untracked 文件。

   这一步排除掉的每一项（untracked 与 tracked 同论）都会在第 5 步被机械地列进结果，**不论你当时多确定**——上面那两条出路（ask / 排除）都以"判断不确定"为入口，而自认确定时的排除不触发任何一条。两件事那道机械闸接不住，只存在于你此刻的记录里：排除的**原因**，以及 **git 看不见的那些排除项**（被 ignore 规则盖住的、`assume-unchanged` / `skip-worktree` 标过的、折叠进内嵌仓库或 submodule 的）——而 lens 点名的 `.cache/`、`node_modules/`、session 日志在多数仓里正属此类。随手记下。

   **粒度 = 一次任务执行，不按 artifact 类型拆**：一个任务目标下产出的代码、测试、文档、experiences、配置属于同一次执行，进同一个 commit（如一个 PR 不会把代码/测试/文档拆成多个）；多个模块的改动仍是一个 commit（用 message bullets 表达），不是拆 commit 的信号。若 working tree 混入了另一个无关任务的改动，先与用户确认，本次只 stage / commit 当前任务的改动。

   **按 artifact 类型拆不是唯一的拆法，还有一种按时间拆**，上一段防不住它：同一件事的产出分几批陆续做完时，每批一绿就提交一次。实测一轮 harness 工作落了 3 个 commit，分界全是时间上的——第二批修的是第一批刚引入的缺陷（那个 hook 一上线就在本 session 开火才暴露），第三批是被一道 Stop 闸推去跑一次审计才产生的。**提交的触发点是「这件事做完了」，不是「这批测试绿了」**：后者在一件事做到一半时同样为真，而且每轮都真，于是有几批就有几个 commit。

   这么拆几乎不带来好处：中间那些 commit 修的缺陷只存在于相邻两次提交之间的几分钟，从未进入任何人用得到的状态，squash 掉不丢可 bisect 的信息；扫 `git log` 找「某个行为什么时候变的」由 message bullet 承接（本文件下面那条「行为变更即使可推导也留一条 bullet」正为此）。代价则是实的：每次提交都要重新加载本文件（`commit-discipline-gate` 按正文在不在 context 里判，不按本轮调过没有），拆 N 批就加载 N 次。

   代价说清楚：这条要求改动在工作树里待得更久，session 中途崩掉就丢。可接受——但一批做完到下一批开工之间跨越了 compaction 或长时间等待时，先落一个 commit 优于赌它还在。

   **有一种分界看着像时间，其实是依赖：这件事自己的验证被 commit 本身挡住**（实测：tt-web 拒绝在 exporter 代码与 HEAD 不一致时导出 generation，不 commit 就取不到要交付的那个页面读数）。此时"这件事做完了"会提前读成成立——产物写完了，验证还没有，而验证要等 commit。**怎么收尾由第 1 步已经读到的那个状态决定**：这棵树只有你在写、该 commit 未推送且仍是 HEAD 时，验证完把记录 amend 进同一个 commit——逐条前提见下面「amend」一节的表，别只按这一句自判；**这棵树**还有第二个决策者时不要 amend，补第二个 commit。落点是共享 tip 的另算：那归 `~/.claude/references/concurrent-plan-isolation.md` 第 5 条，它不禁止 amend，它要求把落点交用户定，amend 与补 commit 都不由你单方决定。

3. **文档同步 checkpoint**：staging 范围定后，判断本次改动是否产生**用户可感知变化 / 服务增删改 / 公共接口变化**（判据见 `~/.claude/references/docs-organization-protocol.md`）。是 → 对应 [User] 档（README / CHANGELOG / operations）必须一并同步进本次 staging，未同步则先补齐再继续；开发者档（architecture / adr / experiences）与 ux-contract 按协议各自路径、不在此强制。追加项落在第 2 步已由用户或 caller 裁定的范围之外时，先回述这个 delta——有人值守经确认后再 stage，无人值守流照常同步但在结果中列出偏离；否则每个经批准的范围都会在 commit 落地时静默地与批准时不同。用户明文排除过该文件时，无人值守流不得径直同步：不 stage，在结果中标为阻塞项——事后列出不等于用户同意；有人值守则把这个冲突并入上面那次回述交用户裁决。例外：本次 commit 由已声明会集中同步文档的 caller（execute-plan / execute-ux-contract 的完整 recipe）驱动时，尊重其编排、不在此重复要求。

4. **生成 commit message**：格式见下方。

5. **执行**：本步的动作是 `git add <specific files>`（第 2 步选定的范围**及第 3 步补齐的 [User] 档**；**禁止** `git add -A` / `git add .`）加 `git commit --only <同一组路径>`。**下面三条前提先过一遍再动手**——部分索引、进行中的序列、新文件必须先 `add`；动完之后还有两条事后核对。

   `git add` 那步不能省：`--only` 只认 git 已知的路径，新文件不先 add 会直接报 `did not match any file(s) known to git`。而它提交的是这些路径的**工作树内容**、不是你 add 过的索引版本——下一条前提正是这个事实的后果。

   **动手前先确认索引里没有刻意重建过的部分改动**（`git add -p`、或按行归属挑过行）：`--only` 会拿工作树内容覆盖它们，那份工作直接丢，而下面那份未纳入清单查不出来（它只查漏、不查多）。有就先把想提交的内容写回工作树再来。

   `--only` 不是可选的谨慎写法：`git add <specific>` 限定不了 commit 范围，它只是往索引里追加，而 `git commit` 落的是**整个索引**——包含开工前就躺在里面、别人 stage 的内容。于是"我只 add 了这几个文件"读起来像范围声明、实际不是，且两者不一致时没有任何回显提示，除非你恰好认出 commit 输出里多出来的文件名。第 2 步定的范围要真正生效，得由 `--only` 兑现。

   **动手前看一眼有没有进行中的序列**（`ls .git/MERGE_HEAD .git/CHERRY_PICK_HEAD .git/REVERT_HEAD .git/rebase-merge`），因为 `--only` 在这几种态下的行为分成两半，而**危险的是能跑通的那一半**：

   | 态 | `--only` | 处置 |
   |---|---|---|
   | merge / cherry-pick | `fatal: cannot do a partial commit during a <merge\|cherry-pick>` | 先 `git diff --cached --name-only` 确认索引里没有第三方 stage 的内容，再用不带路径的 `git commit`，并在结果中写明这次范围没由 `--only` 兑现 |
   | revert / rebase | **exit 0，提交成功** | 它同时把 `REVERT_HEAD` 清掉、把 revert 自己的改动丢在索引里没提交；冲突未解（`UU`）时也照样落 commit，stderr 只给一行不阻断的 `needs merge`。全程零信号，所以这里靠的不是 git 拦你，是你先看过那一眼 |

   别把上面第一行当成"可以省掉 `--only`"的先例——那是 git 不给做，不是范围声明可以不要。

   **未纳入项机械产出，不靠记得写**：`git commit` **之后**跑一次 `git status --short --untracked-files=all`——此时**剩下的一切就是没进这个 commit 的**，逐项列进结果并注明原因（lens 判断 / 落在 user 或 caller 指定的范围之外 / 不属于本次任务），git 看得见的未纳入项一项都没有时显式写"无"。第 2 步记下的**git 看不见的那些排除项**接在这份清单后面单列——机械闸产不出它们，只能来自那份记录，而它们恰恰是最容易静默消失的一类。第 3 步判为阻塞的那一项仍按该步标为阻塞，不并入本清单。并发写入者的产物允许合并成一行计数——它们本就不该由你交代。清单里出现了你以为已纳入的路径，就是 `add` 与 `--only` 不一致：再走一次本流程补一个 commit，别把它悄悄划掉。（漏掉的是本该进这个 commit 的东西时，下面「amend」一节说了什么时候该并回去、而不是补一个。）

   这条读数只看得见**漏掉的**，看不见**多进来的**，所以再对一眼 `git show --stat HEAD` 的文件表是否等于第 2 步选定的那组——用目录或 glob 作 pathspec 时它多半不等，而多进来的东西在上面那份清单里是空的，读起来与"干净"一模一样。（上一段的 merge / cherry-pick 分支不适用：那次的文件表由 merge 决定、不由第 2 步决定，恒不相等。）

   但 `--stat` 判的是**路径集合**，而最隐蔽的两种"多进来"都发生在**同一个路径内部**：共享工作树里别人对同一文件的未完成编辑，以及被 `--only` 覆盖掉的部分索引。两者的文件表都恰好等于你选的那组，两道检查全绿。所以对每个路径再 `git show HEAD -- <path>` 读一眼 diff 正文；共享工作树里则在 `add` 之前先 `git diff -- <path>` 确认工作树只有自己的改动。

   **不要**改用集合相减（拿步骤 1 的未跟踪集去减 `git add` 的参数、或减 `git diff --cached --name-only`）：`git add` 的参数可以是目录 / glob / pathspec，与它实际 stage 的文件是多对多；两侧的路径引用规则也不同（`--short` 对含空格的路径加引号，`--name-only` 不加；非 ASCII 则随 `core.quotePath` 变）。两种减法都会凭空造出未纳入项，而假项出现几次，读者就学会忽略整份清单。

   这份清单是 `~/.claude/CLAUDE.md`「本轮取得的认识不得静默消失」在本 skill 的落点：没进 commit 的东西按定义不进 diff，调用方读交代、读 diff 都够不着它。

   **上面三道检查全在路径与 diff 层面，没有一道让被提交的树自己站起来。** 于是有一类缺陷它们结构上看不见：范围划错时留下的那半自洽，而拿走的那半正是它依赖的东西——文件表恰好等于你选的那组，每个路径的 diff 正文也确实只有你的改动。所以再加一道**执行**检查：

   ```sh
   T=$(mktemp -d); git archive HEAD | tar -x -C "$T"
   (cd "$T" && <本仓的测试命令> <本次 commit 里的那几个测试文件>)
   ```

   「本仓的测试命令」照 `Makefile` / `package.json` scripts / CI 配置里跑测试那一步抄，别自己拟。

   | 方面 | 规定 | 为什么 |
   |---|---|---|
   | 触发 | 本次 commit 的文件表里含测试文件。什么算测试文件，按本仓测试框架实际的收集规则认，别凭文件名猜 | 机械判据，不靠"我觉得这次需要" |
   | 跑在哪 | **导出的树，不是工作树** | 工作树带着你刚排除掉的那些改动，它必然绿——那个绿正是本条要防的读数 |
   | 先验仪器 | 把 `$T` 里某个被测文件改坏，重跑**必须变红**；不变红则这一轮的绿整个不作数，换一个能锁定 `$T` 的跑法（如 `PYTHONPATH=$T/src`）重来 | 这道检查自己也会报假绿，形态与它要防的同构。实测：`pip install -e` 的仓里，导出树明明是坏的、测试照报 `1 passed`——依赖解析回了原工作树；此时把 `$T` 里的文件写成语法错误也仍报 passed，正是这条对照把它抓出来的 |
   | 范围 | 只跑本次涉及的测试文件，不跑全量 | 全量的红多半与本次无关，会淹掉信号 |
   | 「未执行」 | 先排除"只是导出树里没装依赖"（导出树不含依赖、venv 与 `.git`），确属外部服务 / 凭据 / GPU 才这么写，且不得拿工作树的读数顶替 | 否则它会变成默认出口，这道闸退化成零覆盖而没人看得出来 |
   | 跑红了 | 回第 2 步核对排除记录，按本流程补一个 commit | 与另外三道检查的出口对齐 |
   | amend 时 | 同样适用——amend 后文件表仍含测试文件就重跑一次 | amend 去掉一个文件，一样可能把某个依赖排除掉 |

   **覆盖边界要如实读**：它只覆盖"测试文件留在文件表里、而它依赖的东西被排除掉"。测试文件本身也被一并排除、或本次 commit 根本不含测试改动时，本检查**不触发，且没有替代兜底**——上面三道路径检查对这一类同样结构上看不见（这一节开头那句就是说它），别把它读成有人接着。Rust 那种内联 `#[cfg(test)]` 没有独立测试文件，本机制对它结构性失效。

   实测锚点（`philo-prompt` `54e5818`，本机 `~/private-project-c`；完整读数与残留缺口见 `docs/issues/harness-issues.md` 的 `HARNESS-20260822-a71f`，那里是这起事故的归属面，要订正先改那条）：一个新 prompt family 的 spec / 编译器 / 测试 / registry 提交了，而让既有代码认识这个 family 的四个文件留在工作树没进去（是哪四个、各自做什么，以上面那条台账为准——这里不再复述一份）。三道路径检查在这个案例上**按其定义不会报红**——文件表确实等于选定那组、每个路径确实只有作者自己的改动（这是推导，不是"实际跑过并全绿"的读数）。而导出树上 `tests/test_motion_contract.py` **3 failed**，`writer_prompt_fingerprint('magihuman-motion')` 抛 `KeyError`、`validate()` 报 `unknown_family`：`registry.json` 封存的那条 writer 身份，其 sha256 指向一个树上不存在的常量。补上那四个文件后全套 76 passed（`16f2e90`；这两个数字的基线不同——`54e5818` 当时全套 46 个用例，76 是今天 HEAD 的规模）。

   **提交命令的 stderr 不得丢弃。** `git commit … >/dev/null 2>&1` 把三类失败与成功压成同一个空输出：`--only` 的路径不匹配（`did not match any file(s) known to git`）、`--amend` 的拒绝、hook 的拦截。实测一次静默 no-op——命令写成 `git commit --only <新文件> <改文件> --amend --no-edit >/dev/null 2>&1 && echo "已并入"`，新文件没先 `add`，git 非零退出 → `echo` 不执行 → 终端**既没有成功回执也没有错误**，hash 未变、文件没进去，靠肉眼比 `git log` 才发现。`<cmd> && echo 成功` 也不构成回执：成功时它确实打印，失败时 `echo` 不执行、而错误又被重定向吞掉，于是**失败与「命令根本没跑」在终端上同形**。且它只反映 shell 退出状态，证明不了目标文件、提交树或 amend 内容正确——那仍要靠提交后的 hash / `--stat` / `status` 检查。

## amend：默认不做，但它的前提照样适用

本 skill 的产出是**新 commit**（上面那句「再走一次本流程补一个 commit」即此），例外只有一个：**刚落的那个 commit**。现实里仍有该 amend 的场景——把遗漏文件、或验证完才拿得到的记录（见第 2 步那段「验证被 commit 本身挡住」）并入**刚落的那个 commit**。用户已按当前形态批准过时更强：补第二个 commit 反而与他批准的形态不符；仓库授权自主 commit、无批准可言时该场景照样成立——它要的是那个 commit 还改得动，不是有人批过。

**本 skill 之外**发起的 amend（正文不在 context 里）曾是个夹缝：`commit-discipline-gate` 拦的是 `git commit` 这个动词、不区分 amend，而本 skill 当时不管，于是唯一出路是 `COMMIT_SKIP_SKILL_CHECK=1`。走上面第 2 步那条 in-flow amend 时正文必然在 context 里，闸本就放行，**不要**设这个逃生口——它会连带跳过 `git add -A` 禁令与 [User] 档 checkpoint——**跳过闸的同时把下面这些同样适用的前提一起跳过了**。要 amend 就自己兑现它们：

| 前提 | 为什么 amend 同样适用 |
|---|---|
| 新文件必须先 `git add` | `--only` 只认 git 已知的路径；不 add 直接报 `did not match any file(s) known to git`，配合被吞的 stderr 就是一次静默 no-op |
| `--only <paths>` 提交的是**工作树内容** | 它会覆盖你为这些路径 `git add` 过的版本；刻意 stage 过部分改动（`add -p`）时不能用 |
| stderr 不得丢弃 | 见上一段 |
| 提交后机械产出未纳入项，并对一眼 `git show --stat HEAD` | **amend 成功会换 hash**，所以「命令没报错」分不出它到底改没改成；文件表则要等于你选定的那组 |
| 文件表仍含测试文件的，重跑一次第 5 步那道**执行**检查 | amend 去掉一个文件，一样可能把某个依赖排除掉，而那类缺陷路径层的检查看不见 |
| 已推送的 commit 不 amend | 改写已推送的历史要走 force-push，属另一件需要用户显式许可的事 |
| 该 commit 仍是 HEAD | `--amend` 只改 HEAD；别人的 commit 已落在它之上时够不着，此时补第二个 commit 才是正解 |
| 树上没有第二个决策者 | `concurrent-plan-isolation.md` 把 amend 列进作用面覆盖整段历史、在此状态下不再只影响自己的操作 |
| 已把 hash 记进台账 / handoff 的，amend 后回写新 hash | `--amend` 换 hash，而 `execute-plan` 把各单元 commit hash 当可追溯 anchor；不回写它就指向一个不存在的对象 |

## Commit Message 格式

| 场景 | Subject | Body |
|------|---------|------|
| 单改动，无 notable detail | `<type>(scope): <desc>` | 无 |
| 单改动，有 notable detail | `<type>(scope): <desc>` | detail 作为 bullets |
| 多改动（性质不同的改动；一件事的多个侧面算单改动） | 自由文本总结 | 每个改动一条 `<type>(scope): <desc>` bullet |

- Subject 与 body 行均 ≤72 chars——`git log` 左缩进 4 空格后仍在 80 列内
- 语言：整条 message（subject + body）默认英文；仅在用户明确要求、仓库近期 commit 多为中文、或某专有概念无准确英文对应时用中文（末者只该词保留中文）
- Types: `feat` `fix` `refactor` `docs` `test` `chore` `perf` `ci` `style` `build` `revert`
- Body 仅在 subject + diff 不足以让 reviewer 推出非显然设计决策时加
- **调用方关联标记**：上层 command 或 skill 传入时，即使按上一条本可省略 body，也必须创建 body，并把标记原文作为末行；该行同样必须 ≤72 字符。超长属于调用方错误：不得截断或换行，停止并要求调用方提供合规标记。调用方未传入时不添加
- Per-bullet derivability test：每条候选 bullet 自问「reviewer 能从 subject + diff 推出来吗」，能 → drop
  - **diff 含本次一并提交的注释与文档**——复述自己刚写下的注释即判定为可推导。注释在使用现场被读到，commit message 不会；留两份只会各自漂移
  - 例外：**行为变更**即使可推导也留一条。扫 `git log` 找「什么时候变的」的人不会去读注释
- 不附 Co-Authored-By
- 用 heredoc 传递 body（`git commit -m "$(cat <<'EOF' ... EOF)"`）

## 格式锚定示例

单改动，无 body：
```bash
git commit -m "refactor(commands): organize slash commands into namespaced dirs"
```

单改动，有 body：
```bash
git commit -m "$(cat <<'EOF'
feat(llm): replace LiteLLM with native provider SDK adapters

- Native OpenAI/Anthropic/Gemini adapters, no translation layer
- Attempt-count retry with native SDK error classification
EOF
)"
```

多改动（subject 概括这组改动的共同意图，而非罗列各模块名；无统一意图时点明范围，如 `fix several typos across docs`）：
```bash
git commit -m "$(cat <<'EOF'
Overhaul auth and harden the connection pool

- feat(auth): add JWT refresh with a sliding window
- fix(db): resolve connection-pool leak under high concurrency
- refactor(middleware): extract request validation into a shared module
EOF
)"
```
