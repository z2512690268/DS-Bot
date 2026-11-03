# 审批的两级处理：策略表与「需要你」

- 日期：2026-11-03
- 相关：`src/host/approvals.js`、`src/host/approval-policy.js`、`src/client/need-you.js`

## 为什么

Bot 私聊里的审批请求以前只被记录，不显示卡片，也不超时回报：请求落在那个 Bot 自己的聊天里，用户在主聊天跟别的 Bot 说话时完全不知道有东西在等，体感就是「静默卡住」。现场三次 `approval/asked` 都发生在 Runtime 自己的会话里，每次间隔几十秒到几分钟。

但也不能反过来把所有审批一律转给用户：那样用户就成了审批机。先由团队按固定策略判，判不了的才问用户。

## 已定的行为

### 第一级：策略表（确定性，不调用模型）

`approval-policy.js` 按 `toolName`、`reason` 原文、以及工具调用的 `code`（命令 / `file_path` / `url`）匹配，按顺序命中第一条：

| 规则 | 结果 | 覆盖 |
|---|---|---|
| `user-dsh-data` | 拒绝 | 写到用户 DSH 数据（`~/.dsh` 下，团队自己的 `~/.dsh/bot` 与工作区除外） |
| `delete-outside-workspace` | 拒绝 | 删除工作区外的路径 |
| `external-publish` | 拒绝 | 对外发布 / 投稿 / `npm publish` / `gh release` / 把内容发到外部服务 |
| `credentials` | 升级 | 涉及凭据、密钥、密码 |
| `money` | 升级 | 花钱、支付、订阅 |
| `irreversible-action` | 升级 | 删表、`mkfs`、关机等不可逆操作 |
| `irreversible-delete` | 升级 | 删除工作区内但不是构建产物的文件 |
| `global-install` | 升级 | 全局安装 |
| `copy-profile` | 放行 | 副本 / 临时 / 测试 profile |
| `outside-workspace` | 升级 | 改工作区外的路径 |
| `node-modules` | 放行 | 动 `node_modules`（重装依赖、清缓存） |
| `workspace-path` | 放行 | 提到的绝对路径都在工作区内 |
| `install-deps` | 放行 | 装依赖 |
| `lockfile` | 放行 | 更新 lock 文件 |
| `run-tests` | 放行 | 跑测试 |
| `local-task` | 放行 | 本地 lint / build / typecheck |
| `read-only` | 放行 | 只读命令 |

命中放行或拒绝时，`approval/request` 直接返回 `allowed-once` / `rejected`，不显示 DSH 卡片，也不进「需要你」。命中升级、或没有规则命中时，才进入第二级。

### 第二级：升级给用户

- 进 `needsYou()` 的新 `kind: 'approval'`，一行显示哪个 Bot、要在什么工具上提权、具体命令/路径（工具有 `callId` 时）、理由原文、以及「为什么我拿不准」（`unsure`）；有「允许一次 / 拒绝」两个按钮。
- 同一会话有多个待批请求时合并成一条「还有 N 个」，点开逐个处理。
- 点「允许一次」等于用户批准（`allowed-once`），点「拒绝」等于 `rejected`。两者都走既有的 `approval-answer` 通道；由主聊天代答时带 `by`（Main Bot），审计记「由 Chief 代审」。
- 群会话的审批继续由群聊自己代答，不进「需要你」，也不走策略表。

### 超时与拒绝

- 升级后的审批超过 `approvalTimeoutMinutes`（默认 2 分钟）无人处理，向派活方（`work.from`）回报一条 blocked：哪个 Bot、等哪个工具、等了多久、为什么团队定不了。只回报一次，投递失败下一轮再试。
- 拒绝时给 Bot 一句可读理由：拒绝的请求、策略规则（自动拒绝时）、以及「不要重试，仍需要就问用户」。

### 审计

`state.approvalLog` 保存每条决定，`state.approvalAudit` 暴露最近 20 条：

- `decidedBy`：`policy`（策略表）/ `main-bot`（主聊天代答）/ `user`（卡片直接答）。
- `rule` / `ruleWhy`：命中的规则与原因；升级后由人答时记为 `unmatched` / 具体规则，并带 `unsure`。
- `by` / `byName` / `onBehalfOfUser` / `note`：代答的 Bot。
- `via`：`policy` / `needs` / `card` / `group`。
- `tool`、`outcome`、`at`。

## 不做什么

- 策略表不调用模型，避免审批本身又变成一轮可能卡住的对话。
- 不把群会话的审批搬进主聊天。
- 命中「拿不准」的审批不自动放行。
- 自动拒绝的审批不重试；Bot 需要的话自己来问用户。

## 已知限制

- 策略表是关键词 + 路径匹配，不是语义判断；新出现的提权理由可能需要补词表。
- `git push` 不在自动拒绝里：它可能是团队日常的推分支；不命中其他规则时按「拿不准」升级给用户。
- 「副本 profile」靠关键词或 `/tmp` 下的 `profile` 路径识别；放在其他位置的副本可能落到升级。
- 自动拒绝对外发布是硬规则：即使任务本身是用户让发的，只要走到审批也会被拒，需要用户改口径或另行处理。

## 变更

- 2026-11-03：初版。两级审批、策略表、超时回报、代答审计、收件箱合并。
