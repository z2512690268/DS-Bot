# 派活方的上下文预算

- 日期：2026-11-02
- 相关：延续 [派活的报告与等待状态](2026-11-02-work-reports.md)；`report` 与 `needsYou` 的上下文占用

## 为什么

派活树本来是为了让主 Bot 不必自己干活，但每件活的**汇报正文**都会原样投进派活方的上下文。一个 Bot 的汇报常有 2–3k 字，主 Bot 一天几百次调用下来，上下文很快被"派活本身"吃掉——用户看到的现象是：主 Bot 没多久就快满了，然后还是它在干活。

同一时间，主 Bot 并不知道自己还剩多少上下文，于是也不会主动分流。

两件事一起做：**汇报默认瘦身**（派活方只读结论，需要时按路径读全文），**上下文水位可见**（面板上一行，接近窗口时提示分流）。

## 已定的行为

### 汇报瘦身

- Bot 回答一件活时，给派活方的消息默认只含三样：
  1. `report` 的一行：状态（`ready` / `blocked` / `failed` / `dropped`）+ `summary`；`blocked` 带 `human_action` 时那句话也在，所以"卡在哪、要用户做什么"一眼可见；
  2. 回复正文里以 `Needs the user:` 开头的行（最多 3 行）：这是只有用户能做的事，不能因为瘦身丢掉；
  3. `[Full reply: <绝对路径>]` 加一句提示：需要细节时读这个文件。
- 全文原样写进 `~/.dsh/bot/works/<workId>/reply-<n>.md`（`n` 从 1 起）。写文件失败、窗口只读、或活已经不在时，**回退为全文投递**：汇报不能因为瘦身而丢失。
- 每个 work 目录只留最新 5 份回复；同一件活被重新打开再回答会得到 `reply-2.md`、`reply-3.md`。
- `human_action` 的提问卡不受影响：仍在交回回答的那一刻开在派活方的聊天里，内容完整。
- 配置开关 `replyDetail`：
  - `summary`（默认）：上面的瘦身行为；
  - `full`：回到旧行为，整段回复投进派活方。
- 交换记录（`state.exchanges`）里那条 reply 带 `detail`（文件路径）和 `detailLength`（全文长度）；客户端交换对话的「Show all」用它把全文读出来，**不会**把全文塞回派活方的上下文。

### 上下文水位

- 优先用 DSH 自己的实时投影 `contextPressure`（主 Bot 当前那一段 Session 的活数据）：`pressureTokens` 是最近一次请求里 provider 报的 prompt 大小，`projectedTokens` 把它推演到下一次请求，`contextWindow` 是这条路线的窗口。这条路不经过账本，所以不会拿到过期数字。
- 没有活 Agent、或这个 DSH 没有投影时，退回 `usage.sqlite` 的 `calls` 表：只取该 Session 的 `kind = 'turn'` 行（Bot 自己的对话回合），**不取** DS Bot 自己的 `memory` / `compaction` 调用——那些行更新、token 很小，拿它当上下文会让侧栏显示一个假的"很小"的百分比。
- **时效**：账本最后一条 turn 距今超过 `CONTEXT_STALE_MS`（10 分钟）、且之后确实又发过请求时，不能把旧行当现值：
  - 能拿到那次请求的内容，就按"约 4 字符 1 token"估算，并明确标注**估算**；
  - 估不出来就显示"上下文数据未更新"，不给数字。
  - 空闲 Bot（旧行之后没有新请求）仍显示旧值：它下一次请求确实还从那里开始。
- 账本自己每 60 秒扫一次（`SCAN_EVERY_MS`），不再依赖有人打开 Usage 页；`turn` 行、近 24 小时度量、Usage 页都从同一份扫出来的数据来。
- 窗口大小来自模型配置（目录里的 `contextWindow`，或 `llm.resolveModelInfo` 的 `context.contextWindow`）；取不到就只报绝对 token 数并标注"上限未知"。
- `state` 负载里的 `contextBudget`：
  ```jsonc
  { "bot": "Chief", "botId": "…", "sessionId": "…", "model": "deepseek/v4",
    "source": "session",           // session（DSH 投影）| usage（账本）| estimate（估算）| unknown
    "tokens": 298300, "window": 1000000, "percent": 30, "split": false }
  ```
  窗口未知时只有 `tokens`，没有 `percent` / `split`；估算带 `estimated: true`，只有旧行且无法估算带 `stale: true`（没有数字）。
- 面板里一行安静文字：「上下文 62%」；到窗口的 70%（`CONTEXT_SPLIT_RATIO`）变成「上下文 74% · 该分流」。不弹窗、不打断、不改任何行为。
- 快照每 20 秒刷新一次；多个主 Bot 时取第一个。没有调用记录时整行不出现。

## 不做什么

- 不自动分流、不自动重开对话：只提示，决定权在人。
- 不做上下文压缩、不摘要 Bot 的汇报正文：全文原样留在文件里，瘦身只发生在**投递**这一刻。
- **不动系统提示节**（`TEAM_RULES`、`TEAM_DISCIPLINE`、`MAIN_RULES`）：规则每回合都在，省上下文只省投递进来的汇报正文，不为了省 token 删规则或挪规则。
- 不写死窗口大小，也不猜：模型配置说不知道，就显示"上限未知"。
- 不做仪表盘：一行字，健康时不抢注意力。

## 已知限制

- 估算用字符数除 4，只求量级；它带 `estimated` 标记，绝不冒充测量值。
- 实时投影要主 Bot 的会话有活 Agent（打开着的聊天）；没打开时退回账本，账本最多落后约 60 秒（扫描间隔）。
- 账本扫描每 60 秒全量列一次 Session、逐段增量折叠；团队很大时这一步有成本，但只在有变化时读日志。
- 瘦身对所有派活方生效（不只主 Bot）：Bot 之间互相派活时，做活的 Bot 也只看到一行；它需要细节时要自己 `read` 那个文件。
- 一行摘要取自 `report`；Bot 没报过 `report` 时是 `[ready]`（回合结束默认按 ready 理解），不会有正文摘要。
- `usage.sqlite` 的调用记录可能滞后（有写入节流和日志折叠）；水位是近似值，不是下一次请求的精确 token 数。
- 回复文件按 work 目录留存，不随 `workLog` 清理：每个 work 最多 5 份，但目录数量会随工作数量增长。
- 只有第一个主 Bot 有水位行；其他 Bot 的上下文不在面板显示。

## 变更

- 2026-11-02：定下（汇报瘦身 + 上下文水位）。
- 2026-11-02：修上下文水位的过期数字。根因有两条：账本只在打开 Usage 页时才折叠（`scan()` 只被 `usageView` 调用），turn 行因此停在旧时间；而 `latest(session)` 取的是该 Session 最新的任意一行，拿到的常是 DS Bot 自己的 `memory` 调用（live 行、token 很小），于是侧栏显示一个很小却像"当前"的百分比。两处都不涉及 provider 不报 usage——实测日志里两个 provider 的 `assistant/message.usage` 都在，折叠按请求头切换 provider 也正确。修法：优先用 DSH 实时 `contextPressure` 投影，账本只取 `turn` 行并做时效判断，估不出来的明确显示未更新；账本改为每 60 秒自扫。
