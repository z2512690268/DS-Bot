# 续跑：别让链停在半路

- 日期：2026-11-04
- 相关：`feat/work-resume`（基于 `feat/work-state-report`）

## 为什么

今天的真实故障：A 把活派给 B，B 干了一段说「本轮结束，等 job」，然后 job 死了或没挂上，
整条链就停在那里，直到有人（通常是主 Bot）下次主动发消息。ETA 监督只会提醒派活方，
不会驱动链本身。用户反复被这件事坑到，要求从机制上解决。

## 已定的行为

### 续跑（核心）

- 宿主每 5 秒扫一遍所有未关闭的 work。一个 work 可以被续跑，当且仅当：
  - 它不在终态（`ready` / `blocked` / `failed` / `dropped` 都不算）；
  - 它不是在等用户（`person/*` 状态），也不是在等子活（`open` 非空）；
  - 它没有被用户或主 Bot 主动叫停（`work.halted`）；
  - 它还没用完续跑次数（`work.resume.attempts < workResumeMax`）。
- 满足上述条件后，从 `work.at + workResumeSeconds`（默认 30 秒）起算；到点且**拥有者空闲**
  （没有正在跑的回合、没有在跑的后台 job）时，注入一条续跑提示到该 Bot 自己的聊天：
  - role `work-continue`，标题 `[Your work is still open — continue it]`；
  - 正文写明 workId、当前状态、第几次/最多几次、上一步做了什么，并要求：完成就 `report
    ready`，做不到就 `report failed` / `report blocked`；不要等新消息。
- 拥有者不空闲时不注入，只把下一次检查时间往后推 `workResumeSeconds`，所以「回合刚结束
  30 秒内」不会被提前打断。
- 每次注入后 `attempts + 1`；用满 `workResumeMax`（默认 3）仍没结束，就把 work 标成
  `blocked`（`reason: 'no_continue'`）并向派活方发一条 stalled 通知（写明「续跑 N 次仍未
  完成」），之后不再续跑。
- 配置：`workResumeSeconds`、`workResumeMax`；默认 30 秒 / 3 次。

### 停与恢复

- 用户或主 Bot 叫停一个回合（`turn/end` 的 `aborted`，且不是 steer cut）时，该 Bot 手上所有
  未终态的 work 记 `halted`，不再续跑；拥有者下次 `report`（progress 或终态）时自动解除。
- `progress` 报告会重置续跑计数：有了新的进展，就重新给 3 次机会。
- 有后台 job 在跑时同样不续跑：job 结束会自己唤醒 Bot，续跑只负责「链真的停了」的情况。

### 交接必须有下一步

- `report` 增加 `next`（一句话：下一步做什么、归谁）。
- 宿主校验：work 挂在链上（有仍在的 `parent`）时，`ready` 或 `blocked` 报告必须带 `next`，
  否则拒绝并提示重新 report；`progress` / `failed` / `dropped` 不要求。
- `next` 随报告上行：`reportLine` 变成 `[reported ready: …]` + 下一行 `next: …`，派活方读得到。

### 看门狗兜底

- `work.resume`（`attempts` / `nextAt` / `gaveUp`）与 `work.halted` 都落在 `state.json`；
  宿主重启后扫描继续读它，`nextAt` 已过期就直接补一次续跑，不需要额外状态。
- 扫描定时器每 5 秒一次，只做内存比较，不写盘；只有状态变化时才 save。

### 审计

- `state.resumeAudit`（最多 200 条，只读接口 `rt.resumeAudit()`）：
  - 每次续跑：`{ work, bot, kind:'continue', attempt, max }`；
  - 放弃：`{ work, kind:'gave-up', attempts, max }`；
  - 叫停：`{ kind:'halted', bot, reason, works }`。
- work 历史里记 `resumed`（第几次）、`resume-gave-up`、`halted`；work 关闭时 `workLog`
  保留 `resume: { attempts, gaveUp? }` 与最终状态。

## 不做什么

- 不续跑用户叫停的、等用户的、等子活的、有后台 job 在跑的 work。
- 不因为续跑失败就自动改派或升级模型：那是 ETA 阶梯（2026-11-04-work-eta.md）的事，
  这里只保证链不被无声地放下。
- 不新增面板区块：续跑是后台机制，用户看到的仍然是「需要你」里 stalled 的那一行。

## 已知限制

- 续跑提示是投递给拥有者的消息；如果 DSH 没能唤醒它，宿主只会在 30 秒后再试，三次后标
  stalled，不会无限重试。
- 「拥有者空闲」按 `rt.live` 的回合记录判断；宿主刚重启、回合记录为空时，可能对正在恢复的
  会话提前续跑一次（无害：消息排队，回合会读到）。
- `halted` 是粘性的，直到拥有者自己再报一次；如果用户叫停后希望链继续，需要重新发一条消息。

## 变更

- 2026-11-04：初版。续跑（30 秒 / 3 次）、叫停与恢复、`report.next` 校验、跨重启看门狗。
