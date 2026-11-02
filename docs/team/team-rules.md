# 团队工作纪律

- 日期：2026-11-02
- 生效位置：`ds-bot/src/host/prompt.js` 的 `TEAM_DISCIPLINE`（每个 Bot 都读）和 `MAIN_RULES`（只有主 Bot 读）
- 锁定这些文字的测试：`ds-bot/test/prompt.test.js`

这些不是给文档读者看的约定，而是写进系统提示的规则：每个 Bot 每个回合都会读到，所以它们真的改变行为。规则用英文写，因为系统提示是英文的；下面保留英文原文，并写清为什么有这一条。

改一条规则要同时改 `prompt.js` 和 `test/prompt.test.js` 里锁住的原文——那是刻意的：改规则要让测试失败一次，才会被看见。

## 每个 Bot 都读到的六条

### 1. 不伪造工作

> - Never report work that did not happen: do not say an experiment ran when it did not, do not write back a number you cannot reproduce, and say plainly when a result is unverified or was measured on a different basis.

**为什么**：一个会说"跑过了"的 Bot，比一个说"没跑"的 Bot 危险得多——用户会拿它去写论文、做决定。复现不出来的数字写回去，等于把噪音伪装成结论；口径不同（不同数据集、不同硬件、不同 bootstrap 次数）的结果放在一起比较，是这类错误最常见的形态。要求"明说"而不是"别说"，是让人能判断可信度，而不是让 Bot 假装确定。

**测试**：`every Bot reads the team discipline, once, after the team rules`（原文逐条锁在 `DISCIPLINE` 数组里）。

### 2. 长命令走后台

> - Run long commands in the background — run_in_background, or a job that keeps a log — and collect them with job_output; a long command in the foreground holds a turn that could be answering the user.

**为什么**：前台长命令占住回合，用户在等待里既看不到进度、也插不进话；团队里每个 Bot 都这样，用户就在排队。DSH 的 `bash` 支持 `run_in_background`，`job_output` 可以取输出、`job_kill` 可以停；把等待从"回合"里挪出去，用户的消息下一步就能读到。本机的前台等待阈值被调低到 8 秒（见 [本机环境复原](local-setup.md)），超过 8 秒的命令也会自动转后台，但规则要求主动这么做，而不是依赖阈值。

**测试**：同上。

### 3. 同一个仓库各自用 worktree

> - When more than one Bot works in the same repository, each works in a checkout of its own (git worktree); never switch branches in a checkout another Bot or the user is using.

**为什么**：所有 Bot 默认共用一个 checkout，`git switch` 会切到别人头上——本机已经真的撞过一次（一个 Bot 建分支时把另一个 Bot 的工作区切走了，未提交的改动跟着换分支）。`git worktree` 给每个 Bot 一个自己的目录和分支，互不影响，也不需要复制仓库。共享 checkout 只用来读和拉取。

**测试**：同上。实际目录约定见 [本机环境复原](local-setup.md)。

### 4. 只报结果，不报传输层

> - Report the result, not the transport: never paste message envelopes, delivery markers, or lines such as "[Reply from …]" into what the user reads.

**为什么**：`[Message from …]`、`[Reply from …]`、"Delivered to …" 这些是插件在 Bot 之间投递时加的信封，是机器读的标记，不是内容。用户看到它们只会困惑，而且容易把"已投递"误当成"已处理"。要报的是对方回了什么、活到哪一步。

**测试**：同上。

### 5. 用用户的语言，先说结论，只承诺做过的

> - Write in the user's language, lead with the conclusion, then give evidence the user can check, and never promise work you have not done.

**为什么**：用户要的是"成没成、凭什么"，不是过程叙述。先给结论再给可核对的证据（文件路径、commit、测试输出、数字），用户才能一眼判断要不要信。反过来，先讲故事再收尾，读者要花力气找结论。承诺没做的活是另一种伪造：说了"我就去推"但没推，比不回答更糟。

**测试**：同上。

### 6. 常规技术选择自己定，只有大事留给用户

> - Decide ordinary technical choices yourself and say what you decided; leave only spending money, publishing or submitting work, irreversible actions, account credentials, and promises to outsiders for the user to decide.

**为什么**：每个小决定都问一遍，用户就成了 Bot 的审批机；反过来，花钱、对外发布/投稿、不可逆操作、账号凭据、对外承诺这五类，后果由用户承担，Bot 不能替他决定。中间地带（用哪个库、目录怎么放、命名、测试怎么跑）Bot 自己定，并**说明定了什么**，让人可以事后纠正。

**测试**：同上。

## 只有主 Bot 读到的两条

### 7. 新任务立刻下发

> - A new task is handed on at once: give it to the Bot that fits, or create one if none does, instead of working on it yourself for long, so you stay free for the next request.

**为什么**：主 Bot 是用户身边的入口，它一忙，整个团队就"失联"——用户的下一个请求、临时改主意、叫停，都排在一个长任务后面。把活派给专职 Bot（没有就 `create_bot` 建一个），主 Bot 保持可打断，这是团队式分工的前提。团队记忆里也有同样的用户要求。

**测试**：`the Main Bot also reads how a new task is handed on`。

### 8. 只有工具真的返回了才说"已派出"

> - Say a task went out only after message_bot or post_to_group returned; before that it is not sent.

**为什么**：`message_bot` / `post_to_group` 可能被拒（对方不在群里、请求名冲突、只读窗口、投递失败），也可能还在进行中。在返回之前说"已经派给 X 了"，用户就会等一个根本没人做的结果。这条把"说过"和"发生了"分开，和纪律 1 是同一个原则的另一面。

**测试**：同上。

## 与代码的关系

- 提示词前缀必须**逐字节稳定**（`prompt.js` 开头的注释说明了原因：缓存按前缀命中）。这些规则都是静态文本，只随 Bot 自己的记录变化，不随回合、花名册或时间变化——加规则时不要放会变的内容进去。
- `propose`、`report`、`needsYou` 等机制是纪律的执行面：例如观察模式下 Bot 不能自己开活，只能 `propose` 让用户批准；派活的停滞会通知上游。规则和机制要一起读，见 [派活的报告与等待状态](../plans/2026-11-02-work-reports.md)。
