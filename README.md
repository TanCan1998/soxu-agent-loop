# SOXU Agent Loop

SOXU 的开发调度器与本地监控 Dashboard。SOXU 桌面产品由 [SOXU](https://github.com/TanCan1998/SOXU) 单独维护。

本版本为迁移预览，尚未完成端到端发布验证。需 Node.js 24+、Git、GitHub CLI 和 Pi；目标项目的开发检查还需要项目自身的工具链和模型认证。

## 配置与启动

在 PowerShell 中显式指定目标项目的绝对路径。所有 Git、GitHub、任务和策略操作以该目录为准：

```powershell
$env:SOXU_PROJECT_ROOT = 'F:\workplace\pi\SOXU'
node automation/loop/src/cli.mjs doctor
node automation/loop/src/cli.mjs status
node automation/loop/src/dashboard-cli.mjs
```

`status` 默认读取 GitHub 任务命名空间（`github-issue-N.json`），`status --local` 读取本地队列命名空间（`local-issue-N.json`）；两者都只读本地数据、不访问 GitHub，输出首行会标明当前模式。SOXU 这类以 GitHub Issue 驱动的项目应使用不带参数的 `status`。

Dashboard 仅监听 127.0.0.1，访问令牌由启动时生成。默认继续使用目标项目的 `.soxu` 数据目录，与旧检查点兼容。Worktree 仍属于目标项目；迁移不会移动或删除它们。

## 迁移运行数据

先退出所有旧版和新版 Dashboard、Runner 和正在运行的 Agent，检查 `.soxu/locks`；存在锁时迁移拒绝执行。下例将全部受支持的检查点、报告、草稿和模型设置复制到一个**尚不存在**的目录，核对前后内容并保留原数据。旧程序无法识别新目录：切换后不要再运行旧程序，否则两份状态会分叉。

```powershell
node automation/loop/src/migrate-data.mjs 'F:\workplace\pi\SOXU' 'F:\workplace\pi\soxu-loop-data' --offline
$env:SOXU_PROJECT_ROOT = 'F:\workplace\pi\SOXU'
$env:SOXU_DATA_DIR = 'F:\workplace\pi\soxu-loop-data'
node automation/loop/src/cli.mjs start --local --dry-run
```

不设置 `SOXU_DATA_DIR` 时仍使用旧数据；切回旧目录前必须先停止进程并核对状态。任务锁保留在目标项目 `.soxu/locks`，以便新旧程序识别共同任务锁。旧程序不会强制遵守迁移约束，`--offline` 需要操作者确保所有进程已停止。

## 验证

```powershell
$env:SOXU_PROJECT_ROOT = 'F:\workplace\pi\SOXU'
npm test
```

测试包含 SOXU 目标项目的集成契约；运行前需准备 SOXU 工作副本。不要将模型密钥或本地运行数据提交到仓库。

Dashboard 热更新尚未实现；不要依赖更新不中断正在执行的任务。

## 热更新（不中断任务）

工具更新只移动本仓库的检出，不影响正在运行的任务：任务进程已经把所需模块加载进内存，新代码只对**之后**启动的进程生效。

```powershell
# 只检查，不写工作区
node automation/loop/src/cli.mjs update --check

# 应用：快速前进 + 冒烟门禁，失败自动回滚
node automation/loop/src/cli.mjs update
```

Dashboard 提供同样能力：`POST /api/update`，请求体为 `{"action":"check"}` 或 `{"action":"apply"}`；执行页的「工具热更新」面板有对应按钮。

行为与边界：

- 只做 `git merge --ff-only`。工作区脏、没有 upstream、远端不可达都直接拒绝并说明原因。
- 应用后跑一次快速冒烟（status 测试）；失败则 `git reset --hard` 回到更新前提交，返回 `rolled-back`。
- 正在运行的任务不会被重启或中断。Dashboard 崩溃或重启后，会用目标项目的 `.soxu/runner/state.json` 与持久日志重新接管该任务（快照里 `runner.attached = true`），并且仍然可以停止它。
- 运行器在状态文件里记录 `protocolVersion`。协议不匹配时只展示状态、拒绝控制动作（`409 incompatible-runner`），不做兼容性猜测。
- “Dashboard 自身”要用新代码仍需重启一次；已在跑的任务继续使用旧代码直到结束。

## 命令面（简化后）

```powershell
node automation/loop/src/cli.mjs start            # 先恢复 paused/blocked，无可恢复再执行下一批
node automation/loop/src/cli.mjs start --dry-run  # 只预览会走哪条路径
node automation/loop/src/cli.mjs loop             # 有界自动循环
node automation/loop/src/cli.mjs watch            # 持续监控（受策略限制）
node automation/loop/src/cli.mjs status           # 本地任务状态
node automation/loop/src/cli.mjs doctor           # 工具链与恢复状态
node automation/loop/src/cli.mjs models           # 模型路由
node automation/loop/src/cli.mjs cleanup          # 清理已合并任务分支
node automation/loop/src/cli.mjs seed-issues      # 发布 backlog 为 Issue
node automation/loop/src/cli.mjs say -- "继续 SOXU"  # 自然语言恢复
node automation/loop/src/cli.mjs update           # 从 GitHub 热更新（--check 只比较）
```

`once` 与 `resume` 已移除：`start` 在同一个受管子进程里先恢复、再按需执行下一批，避免两个 Runner 争抢工作树。页面上的按钮同为「启动」「启动循环」「启动监控」；阻塞任务不再有单独的“恢复此任务”入口，统一由「启动」处理（需先自行确认阻塞原因已解除）。
