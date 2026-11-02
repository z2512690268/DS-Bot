# 本机环境复原

- 日期：2026-11-02
- 适用：这台 Mac 上跑 DS Bot 团队（DSH 桌面应用 + 共享代码 checkout）
- 目的：换机或重装后，照着这份把"只活在运行环境里"的东西恢复回来。全部是**手动步骤**——仓库硬规则 5 不许碰用户的 DSH 数据，所以这里不提供、也不该写任何自动修改 `~/.dsh` 的脚本。

## 1. 目录

| 东西 | 路径 |
|---|---|
| 共享 checkout（所有 Bot 只读、只拉取；不要在这里切分支） | `/Users/gunk/.dsh/bot/workspace/DS-Bot` |
| 我的 worktree（分支 `feat/team-discipline`） | `/Users/gunk/.dsh/bot/workspace/wt-scheduler` |
| 另一个 Bot 的 worktree | `/Users/gunk/.dsh/bot/workspace/wt-runtime` |
| 桌面应用的 DSH profile | `~/.dsh/profiles/desktop/` |

工作区里还有 `.tools/`、`.logs/`、`.mcp-profile/` 等运行目录；工作文件（论文、实验脚本、文档）在 `~/.dsh/bot/workspace/` 下，不在仓库里。

## 2. profile：ds-bot 是 link，指向仓库

`~/.dsh/profiles/desktop/package.json` 里：

```json
{
  "dependencies": {
    "ds-bot": "link:/Users/gunk/.dsh/bot/workspace/DS-Bot/ds-bot"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "...",
        "ds-bot"
      ]
    }
  }
}
```

- `dependencies` 里是 `link:`，所以改仓库里的源码就是改正在跑的插件，不需要重新安装。
- `node_modules/ds-bot` 是一个 symlink，指向 `../../../bot/workspace/DS-Bot/ds-bot`（也就是共享 checkout 里的 `ds-bot/` 目录）。删掉 node_modules 重装时它会被重建。
- `dsh.profile.bundles` 里必须有 `ds-bot`，否则插件不会被加载。
- `~/.dsh/profiles/desktop/cordis.yml` 是空入口列表（`[]`），真正的配置在 `cordis.patch.yml`。

`~/.dsh/profiles/web/` 是另一套（空的，没有 ds-bot）。桌面应用用的是 `desktop`，别照 `web` 配。

## 3. cordis.patch.yml 尾部的三行 8 秒配置

`~/.dsh/profiles/desktop/cordis.patch.yml` 末尾（原文，含注释）：

```yaml
# 前台命令的默认等待从 60 秒降到 8 秒：超过 8 秒仍在跑的命令自动转成后台 job，
# 回合立刻让出，用户的消息/steer 在下一步就能读到；命令本身继续跑，可用
# job_output 看输出。DSH 的 60 秒默认来自 dsh-base 的 bash-sandbox.timeoutMs (60000)。
# 显式传 timeoutMs 的命令不受影响，上限（maxTimeoutMs 600000）也不变。
- id: bash-sandbox
  config:
    timeoutMs: 8000
- id: pwsh-sandbox
  config:
    timeoutMs: 8000
# job_output 的默认等待同样从 30 秒降到 8 秒；显式 timeout_ms 仍可到 600000。
- id: tool-jobs
  config:
    waitTimeoutMs: 8000
```

为什么是 8 秒：要让"回合永远留给用户"，长活必须去后台跑。DSH 默认 60 秒，一条几分钟的命令会把回合整个占住，用户的消息和 steer 都读不到；8 秒是本机测试下来"够短、又不至于把正常的快命令都转后台"的折中。显式传 `timeoutMs` 的命令不受影响，所以真正需要等的前台命令仍然可以自己放宽。

**改完要重启桌面应用才生效**：patch 层在启动时读入，热改文件不会重载。

## 4. 备份

改动 profile 之前做的两个备份在：

```
~/.dsh/bot/workspace/.tools/backup/profile-package.json.bak
~/.dsh/bot/workspace/.tools/backup/profile-pnpm-lock.yaml.bak
```

要回滚就把这两个文件手动拷回 `~/.dsh/profiles/desktop/`（`package.json`、`pnpm-lock.yaml`），再重启应用。备份不含 `cordis.patch.yml`——那个文件是逐条追加的，删掉对应几条即可回到默认。

## 5. 换机恢复步骤（手动）

1. 克隆仓库到 `/Users/gunk/.dsh/bot/workspace/DS-Bot`（`git clone git@github.com:z2512690268/DS-Bot.git`，SSH key 见下）。
2. 确认 `~/.dsh/profiles/desktop/package.json` 里 `ds-bot` 是 `link:/Users/gunk/.dsh/bot/workspace/DS-Bot/ds-bot`，并且 `dsh.profile.bundles` 里有 `ds-bot`。
3. 在 `~/.dsh/profiles/desktop/` 里重装一次依赖，让 `node_modules/ds-bot` 这个 symlink 重新建出来（例如 `pnpm install`，用应用自己的包管理器版本）。
4. 把第 3 节的四段（三条 patch 条目加注释）追加到 `cordis.patch.yml` 末尾。
5. 重启桌面应用。
6. 核对：面板能打开、`list_bots` 有成员、在一个 Bot 的 worktree 里 `npm test` 能过（测试要 `dev/harness/node_modules`，见 `ds-bot/AGENTS.md` 的 `npm run harness`）。

推代码用已经存在的 SSH key（`git@github.com:z2512690268/DS-Bot.git`）；这台机器的 https 没有 credential helper，`git push` 会卡在用户名。

## 6. 没有进仓库、也刻意不冻结的东西

- **各 Bot 的 instructions 和团队记忆**：存在运行环境 `~/.dsh/bot/state.json` 里。这些是用户和 Bot 一起长出来的东西，没有一致的导出格式，换一套团队就不成立，所以**不做导出、不做回填**；重建团队时按新的需要重新写。
- **API key / 凭据**：只存在环境的 secret 里，不进仓库、也不进本文档。
- 团队纪律和踩坑记录本身进了仓库（[团队工作纪律](team-rules.md)、[踩过的坑](lessons.md)），因为那些规则不依赖具体某个 Bot。
