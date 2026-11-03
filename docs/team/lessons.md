# 踩过的坑

- 日期：2026-11-02
- 这份文档记的是**已经真出过问题**的事：现象、根因、修法、怎么防回归。每条末尾的 commit 或测试就是"下次改坏了会被发现"的证据。
- 没有 commit 的条目，说明修法是运行环境里的配置或流程，不在仓库里；对应做法记在 [本机环境复原](local-setup.md)。
- 反复出现的坑已经提炼成 [团队工作纪律](team-rules.md) 里的规则，写进了系统提示。

## 1. 空闲的 Bot 收到消息不回

**现象**：另一个 Bot 的消息或回复已经投递成功，界面、日志、待处理队列里都能看到，但目标 Bot 一直不动；用户以为消息丢了。

**根因**：DSH 的回合由驱动（driver）唤醒才开始。投递只把消息放进 Session 的队列，不会自己叫醒驱动；Bot 空闲时没人叫，消息就一直待在队列里。第一版修法走反了方向：把队列里的消息取出来重发一次——消息于是既进了回合、又留在待处理队列，模型读了两遍，界面上也显示成重复投递。

**修法**：投递之后显式唤醒驱动（`agent.wakeDriver()`），消息留在原处不动。队列是唯一真相，唤醒只是"叫一下人"，不是"重新发一次"。

**防回归**：`59dd950` 把重发改成只唤醒；`ea1fc65` 是第一次唤醒的修复。`ds-bot/test/bot-messages.test.js` 的 `message_bot steers by default; on an idle Bot it opens the next turn` 断言空闲时只投递一次。

## 2. 正在跑的回合里，别的 Bot 的回复被排到下一回合

**现象**：上游 Bot 在等一个结果，工作 Bot 一边跑一边被下游的回复"等回合结束"，上游因此多等一整轮思考；界面看起来像卡住。

**根因**：回复按普通的 `followup` 投递，即使目标正在跑也要排队到下一个回合；而目标此刻正需要这条回复才能继续。

**修法**：投递时看目标是否在跑：`role === 'reply'` 且目标有回合在跑，就 `steer` 进当前回合，下一步就能读到；否则照旧 `followup`。两种情况都是"一条回复只读一次"。

**防回归**：`94fd23b`。请求侧的行为锁在 `ds-bot/test/bot-messages.test.js` 的 `message_bot steers by default; on an idle Bot it opens the next turn` 和 `a request steered into a running turn is recorded once and answered in a turn of its own`。

## 3. 前台长命令占住整个回合

**现象**：Bot 跑一条要几分钟的命令，整个回合卡在那里；用户发消息、steer 都读不到，界面像卡死。

**根因**：DSH 前台命令的默认等待是 60 秒（`dsh-base` 的 `bash-sandbox.timeoutMs`）。命令没结束，回合就一直在等它，用户的消息只能排在后面。

**修法**：本机 profile 把前台等待降到 8 秒：`bash-sandbox` / `pwsh-sandbox` 的 `timeoutMs: 8000`，`tool-jobs` 的 `waitTimeoutMs: 8000`。超过 8 秒的命令自动转成后台 job，回合立刻让出，命令本身继续跑，之后用 `job_output` 收；显式传 `timeoutMs` 的命令不受影响，上限仍是 600000。改完要重启桌面应用才生效。

**防回归**：没有仓库 commit（这是用户 profile 里的配置，不进 git）。原文和恢复步骤在 [本机环境复原](local-setup.md)；团队纪律第 2 条要求主动走后台，不依赖这个阈值。

## 4. 面板里点了「继续」，条目还占着看板

**现象**：用户在「需要你」里点「继续」或发一句话，消息确实到了 Bot，但那条还在面板上。用户不知道是没发出去，还是发了没反应。

**根因**：发送和"这条已经从列表消失"是两件事，面板只在等服务端下一轮状态时才更新；中间这段没有任何本地反馈。发送失败也没有回退，条目会一直挂着。

**修法**：点下去先本地隐藏（乐观更新），再发消息；发送成功后才用同一个 work 的 key 调 `needs-dismiss` 在服务端确认。发送或确认失败就把条目放回来并提示。隐藏规则与服务端共用：隐藏时刻不早于条目当前状态的 `since`；这件活之后又报新状态，会重新出现。重复 dismiss 不报错（幂等）。

**防回归**：`3639bd5`。`ds-bot/test/needs-panel.test.js` 的 `clicking Go on takes the row away at once, and the host is told to drop it`、`a reply that failed brings the row back and tells the user`、`a dismissal the host did not take also brings the row back`；`ds-bot/test/needs-inbox.test.js` 的 `dismissing the same item again is not an error`。

## 5. 点掉之后，健康线还显示「1 个停滞」

**现象**：面板把一条停滞的活 dismiss 了，条目没了，健康线仍显示"1 个停滞"；重启后还在。

**根因**：健康线自己数 `work.report?.stalled === true` 的活，而 `needsYou()` 用 dismiss 记录过滤；两个地方各数各的，于是同一件活在两个地方说法不一致。

**修法**：抽出共用的"这一行是什么"（`workRowOf`：kind + 当前状态的 `since`）和"是否被 dismiss"（`dismissedAt(key, since)`），`needsYou()`、`workHealth()`、dismiss 三处共用；健康线的停滞计数走同一条规则。

**防回归**：`f3709dd`。`ds-bot/test/work-health.test.js` 的 `a dismissed stall leaves the health line and the team file`。

## 6. 停滞且已 dismiss 的活长期占着 `works()`

**现象**：改了第 5 条之后健康线对了，但那种"dismiss 发生在修复之前"的活一直留在 `state.works` 里，看不见也清不掉。

**根因**：`dropWork` 只在用户点 dismiss 的那一刻触发。更早被 dismiss 的活没有人再扫它，就一直占着状态文件。

**修法**：停滞扫描顺带清理"已停滞 + 已 dismiss + 没有在跑的子活"的活：`dropWork` 掉，`workLog` 留一行；带子活的先不动（别误删还在跑的树）。扫描幂等，收掉后自然不再出现。

**防回归**：`cc74da4`。`ds-bot/test/work-health.test.js` 的 `a stall dismissed before the cleanup existed is cleared by the next sweep`、`a work that is still running is hidden, never dropped`。

## 7. 提问卡：问句、自由输入、答案原路回到同一件活

**现象**：三类都真出过——卡片标题写成了命令或标签而不是用户语言的问句；卡片只给选项、没有自由输入，用户想答的内容不在选项里；用户在卡上答完，答案被当成一件新活，或者被转载时改写了措辞，做活的 Bot 接不上原来那件活。

**根因**：提问卡一开始只是"显示一段文字 + 按钮"，没有把它和派活树里的 work 绑起来；答案回流也没有约定"同一件活"的标识。

**修法**：卡片的标题就是 `human_action`，必须是一句用户语言的问句；`human_options` 只是快捷选项，永远保留自由输入；答案在原 work 上开一条请求（同一个 `workId` / `exchangeId`）发回做活的 Bot，内容原样带上用户选的和写的，不另开新活、不改写。

**防回归**：自由输入和原路回流在 `cfb3be7`、`7d97730`。`ds-bot/test/work-report.test.js` 的 `a report that needs the user puts the question where the work was asked for`、`the answer to one of those cards goes straight to the Bot that could not go on`；`ds-bot/test/work-card.test.js` 覆盖真实回合开卡；`ds-bot/test/needs-panel.test.js` 锁住 `allowCustom` 的自由输入。

## 8. 传输层字段漏进用户能看到的地方

**现象**：用户界面或待处理输入里出现过 `[Reply from Writer]`、`Delivered to Writer…`、`[reported ready: …]` 这类行；用户以为 Bot 在自言自语，或者把"已投递"当成"已处理"。

**根因**：这些是插件给模型看的信封和汇报行——`delivery` 在消息前面加 `[...]` 头，`reportLine` 在交给上游的回答上面加一行业务态。它们和正文在同一层，只要有人原样转述，就会漏到用户面前。

**修法**：约定这些行只属于机器层。客户端用 `stripHeader` 把 Relay 头从用户可见的消息里剥掉；汇报行只加在"交给上游 Bot 的回答"上，不进用户气泡；Bot 也不能把它们贴给用户。

**防回归**：`ds-bot/test/relay-header.test.js`（三种带括号的 Bot 名、单行消息、正文里的方括号都不能被误剥）；`ds-bot/test/work-report.test.js` 的 `the report line is empty without a report, and names the outcome with one`；团队纪律第 4 条写进了系统提示并锁在 `ds-bot/test/prompt.test.js`。

## 9. 复现不出来的数字不能留着

**现象**：一份结果里写着"37.5%"这个比例；按原来的定义复算，它对应的运行反而更慢（3033s 对 2885s），数字本身没错，但口径复现不出来，读者无法核验。另一类：论文里没做的实验被写成了做过。

**根因**：统计口径没有在取数时写死（按哪批运行、怎么去重、按什么单位算），于是同一个百分比可以对应多种算法；而"没做的实验"是被叙述补上的，不是被数据补上的。

**修法**：复现不出来的数字要么换成可复算的口径（例如按 75% 重叠统计），要么删掉；论文里没做的实验不能写成做了。**宁可少一个数字，不留一个说不清的数字。**

**防回归**：团队纪律第 1 条（不伪造工作、复现不出来的数字不写回、口径不同要明说），锁在 `ds-bot/test/prompt.test.js`。这类问题没有代码测试能兜住，规则和审阅是防线。

## 10. 说"任务已派出"，但其实没派出去

**现象**：主 Bot 告诉用户"已经派给 X 了"，然后用户等一个根本没人做的结果。实际是 `message_bot` / `post_to_group` 被拒绝（目标不在群里、请求名冲突、窗口只读、投递失败），或者调用还在进行中。

**根因**：Bot 把"打算派"写成了"已派出"，把工具的调用意图当成了结果。

**修法**：只有工具真的返回了，才能说派出了；返回之前的正确表述是"正在派"或干脆先不说。这也是"不伪造工作"的另一面。

**防回归**：`MAIN_RULES` 第 8 条，锁在 `ds-bot/test/prompt.test.js` 的 `the Main Bot also reads how a new task is handed on`。

## 11. 多个 Bot 动同一个仓库

**现象**：一个 Bot 在共享 checkout 里 `git switch`，把另一个 Bot 的工作区切走了，未提交的改动跟着换分支；两个 Bot 的分支互相覆盖。

**根因**：所有 Bot 默认共用一个 checkout，`git switch`/`git checkout` 是仓库级操作，不隔离到"某个 Bot"。

**修法**：每个 Bot 用自己的 `git worktree`（独立目录 + 独立分支），共享 checkout 只读、只拉取，绝不在里面切分支。本机的目录约定见 [本机环境复原](local-setup.md)。

**防回归**：团队纪律第 3 条，锁在 `ds-bot/test/prompt.test.js`。

## 12. 上下文压缩会丢任务级约束

**现象**：一次会话压缩（`[Checkpoint N]` 或 `[Handoff · part N]`）之后，长期规则还在，但这次任务的一次性约束丢了或者变了形：用户说过"这会别动论文稿"，压缩后 Bot 又去改；"正文必须 6+1 页"，摘要里变成"尽量短"；"用 4k 上下文，不是 8k"，下一个回合按 8k 跑。规则还在，具体的"这一次"已经不在。

**根因**：`prompt.js` 里的 `TEAM_RULES`、`TEAM_DISCIPLINE`、`MAIN_RULES` 是每回合从静态常量重新渲染的系统提示节（`interpolate: false`），压缩只处理历史消息，碰不到它，所以"规则"永远在；而任务级约束只活在对话里，压缩摘要由模型生成，模型不保证把每一条一次性约束都忠实搬进去。越是"只对这次有效"的东西，越容易被当成上下文里的一句话而不是约束。

**修法**：一次性的任务约束写进 workspace 文件或仓库文档（例如任务目录下的 `NOTES.md`、计划文件、`AGENTS.md` 里的相关段落），让它在压缩前后都是同一个可读的落盘事实；记忆只放跨会话仍然成立的东西（`MEMORY.md` 有 4000 字上限，细节进 topic），不要把"这一次"塞进记忆。压缩之后先读那份文件再动手。同理，环境事实（profile 配置、8 秒阈值、worktree 目录）也不要只靠对话记着——见 [本机环境复原](local-setup.md) 的"环境事实要落盘"。

**防回归**：这条本身没有测试可以锁，属于流程约定：在文档里写明，并在任务开始时就把一次性约束落盘。能自动检查的只有"落盘之后还在"（文件、`read`）；压缩是否忠实属于模型行为，不进入单元测试。

## 13. 主 Bot 会把自己当执行者，机制要在没有派发的回合里拦住它

**现象**：用户让主 Bot 查一下 PaperBase 的收集量和顶会覆盖，主 Bot 把这当成"看一眼的事"，自己连服务、写 MCP 握手脚本，一个 Bot 都没派。它做完了，但没有任何东西阻止它，也没有任何东西让这件事在面板上可见——用户只能事后问"你为什么自己做"。

**根因**：主 Bot 是团队的入口，但它的回合和普通执行者一模一样：工具调用没有上限，也没有"这一回合派了什么"的信号被记录。职责边界只写在提示词里（"不亲自做可外包的长任务"），而提示词是软的，上下文一紧、任务看起来一小，这条就会被绕过。团队真正缺的是两个机制事实：**这一回合自己做了多少**和**有没有派发**。

**修法**：两件一起做。审计：主 Bot 每个做了事的回合记下工具调用、shell、写文件、派发的 works、时长和 `keep_working` 理由，24 小时汇总成面板一行，让"自己动手"可数。闸门：主 Bot 单回合工具调用达到阈值（默认 10）且整回合没有任何派发（没有新 work、没有 `message_bot`、没有 `post_to_group`）就停掉回合，并告诉它两条路——把活交给合适的 Bot，或调 `keep_working` 说明为什么必须自己做；理由进审计。派发过的回合不论后面做多少都不拦，非主 Bot 不适用。

**防回归**：`ds-bot/test/work-audit.test.js`（无派发且超限 → 停；有派发 → 不停；`keep_working` → 解除并留痕；非主 Bot → 不触发；阈值可配；审计进 state/面板）。设计见 [主 Bot 的自身工作](../plans/2026-11-03-main-work-gate.md)。这条经验的关键是"机制而不是提醒"：只改提示词不算修好。
