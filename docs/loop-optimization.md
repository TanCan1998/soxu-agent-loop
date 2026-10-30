# Loop 优化盘点（2026-10-30）

基于 V4 首轮实战（10 个切片、12 个 PR、6 次 blocked）暴露的问题，按影响分级。

## 战果基线

```
已合并 6 个切片  #112 #116 #117 #118 #119 #121
loop 自身修复 5 个  #73 #74 #75 #76 #77
弃用重做 2 个      #120（11 文件冲突） #122（8 文件 + Cargo.lock）
人工 rebase 3 次   #117 #119 #121
人工改 checkpoint 1 次  #116（running 脏状态）
人工改 issue 标签 6 次  （依赖转换失效期间）
```

---

## P0 阻断类（不修则无法稳定跑完）

### P0-1｜PR 冲突后没有自动恢复

**证据**

四个后端切片并行，四个 PR 全部 `CONFLICTING`：

```
PR #129 [CONFLICTING] +3688   #119 上下文环
PR #130 [CONFLICTING] +4451   #121 Git 抽屉
PR #131 [CONFLICTING] +4250   #120 文件抽屉
PR #132 [CONFLICTING] +4715   #122 终端抽屉
```

loop 只报错进 blocked，不尝试任何恢复：

```
issue #120 blocked at merge: PR 与集成分支 dev 冲突（mergeable=CONFLICTING），需 rebase 后重跑
```

`recover()` 调用 `prepareWorktreeRecovery`，但它只在 **worktree 落后于 base** 时 rebase，
不处理 **PR 与 dev 的冲突**。结果 4 个 PR 全部需要人工处理。

**代价**：手工 rebase 3 次（#117 2 处、#119 1 处、#121 3 处），2 个放弃重做。

**方案**

merge 阶段检测到 `CONFLICTING` 时，自动走冲突恢复：

1. worktree 里 `git fetch origin <base>` + `git rebase origin/<base>`
2. rebase 成功 → 重跑 checks → 重新 push → 重试 merge
3. rebase 冲突 → 统计冲突文件数与块数：
   - 少于阈值（建议 3 文件 / 5 块）→ 交给 Developer Agent 解决（它有能力）
   - 超过阈值 → blocked 并在评论里列出冲突文件清单
4. `Cargo.lock` / `pnpm-lock.yaml` 冲突 → 直接采用 base 版本，重跑 `cargo build` / `pnpm install` 重新生成

### P0-2｜手工 rebase 后 issue 永不关闭

**证据**

```
Cleanup #119: PR head f5818cda ≠ checkpoint b9495118，保留现场待人工核实
Cleanup #121: PR head 13b2bd83 ≠ checkpoint e321d1e，保留现场待人工核实
```

cleanup 的判定：

```js
if (pr.headRefOid !== sha) {
  const contained = await exec("git", ["merge-base", "--is-ancestor", sha, pr.headRefOid]);
  // 不一致且不是祖先 → not-verified → 跳过
}
```

手工 `git rebase` 会改写 commit SHA，旧 SHA 不再是新 head 的祖先 → 永久跳过。

结果：#117 #119 #121 三个 PR 已合并进 dev，issue 至今 OPEN。

**方案**

1. merge 阶段成功合并后，把**合并后的 commit SHA 回写 checkpoint**（`state.mergedHead`）
2. cleanup 判定增加第三档：`pr.state === "MERGED"` 且 `pr.headRefName === state.branch` 且 issue 号匹配 → 允许清理，即使 head 不一致
   - 理由：PR 已合并是硬事实，head 变化只说明有人 rebase 过
3. 提供 `pnpm agent:cleanup --force <issue>` 用于人工确认后强制收尾

### P0-3｜`recover()` 硬编码 `includeBlocked = true`

**证据**

```js
async function recover(selected = null) {
  const includeBlocked = true;   // 硬编码
```

`loop` 启动时的自动恢复调用 `recover()`，于是把 **blocked 的任务也一并拉起**：

```
Resuming 1 interrupted task(s) before the loop
resume #117: ...   ← #117 当时是 blocked（空行问题未验证）
resume #118: ...
```

**方案**

`recover(options)` 接受 `{ includeBlocked }`：
- `loop` 自动恢复 → `includeBlocked: false`（只恢复 paused）
- `start` 命令 → `includeBlocked: true`（人工显式恢复，含 blocked）

---

## P1 效率类

### P1-1｜前端 `App.vue` 是冲突热点

**证据**：4 个 PR 的冲突文件

```
#129  sessionWorkspace.ts（1）
#130  App.vue + stores/workspace.ts（2）
#131  App.vue + stores/workspace.ts + Rust 9 个文件（11）
#132  App.vue + Cargo.lock + Rust 6 个文件（8）
```

**Rust 侧零冲突**——`lib.rs` 的 9 个领域占位块完全生效。但前端没有对应机制。

**方案**

给 `App.vue` 预置挂载点注释块，与 `lib.rs` 同构：

```vue
<!-- 顶栏按钮（按 TASK 号顺序追加，每次一行） -->
<!-- 抽屉面板挂载（同上） -->
```

`stores/workspace.ts` 同理：预留 `// ── 领域状态（按 TASK 号追加）──` 段。

并写进 `docs/development/command-blocks.md`（改名为 `insertion-points.md`）。

### P1-2｜并行度与实际收益倒挂

**证据**

`maxConcurrentAgents=4` 时：4 个切片同时开发 → 4 个 PR 全冲突 → 3 次人工 rebase + 2 次重做。
净效率 **低于串行**。

**方案**

1. 默认 `maxConcurrentAgents: 2`（不是 4）
2. 并行前做**冲突预检**：如果两个待跑切片的文件集有交集（可从 task 的 `scope` 或历史 diff 推断），串行执行
3. 前端切片强制串行（在 `App.vue` 挂载点机制落地前）

### P1-3｜checkpoint `status=running` 脏状态

**证据**：#116 的 checkpoint 卡在 `phase=checks status=running`，但进程已退出，loop 空闲。
我手动改成 `paused` 才能恢复。

**方案**

1. runner 启动时扫一遍 checkpoint：`status === "running"` 但没有对应进程 → 改成 `paused` 并记录原因
2. dashboard 启动时做同样的事（进程可能被 kill -9）

---

## P2 可观测类

### P2-1｜冲突原因不透明

**证据**：只报 `PR 与集成分支 dev 冲突（mergeable=CONFLICTING），需 rebase 后重跑`，
不列冲突文件，每次都要人工 `git merge-tree` 查。

**方案**：blocked 评论里附冲突文件清单与块数：

```
冲突文件（3 个，共 7 处）：
  apps/desktop/src/App.vue（5 处）
  apps/desktop/src/stores/workspace.ts（2 处）
  apps/desktop/src-tauri/src/lib.rs（0 处，可自动合并）
```

### P2-2｜cleanup 的 `not-verified` 不够醒目

日志有但埋在几百行里。建议在 dashboard 的「任务列表」里对这类 issue 显示 ⚠️ 标记。

---

## 建议的优化批次

| 批次 | 内容 | 预期收益 |
|---|---|---|
| **L1** | P0-1 冲突自动恢复 + P0-2 合并后回写 SHA + P0-3 recover 参数化 | 消灭人工 rebase 与孤儿 issue |
| **L2** | P1-1 前端挂载点 + P1-2 并行策略 + P1-3 脏状态清理 | 并行不再互相踩 |
| **L3** | P2-1 冲突清单 + P2-2 面板标记 | 排查不用翻日志 |

**L1 完成前不建议启动新一轮**：否则同样的冲突会再发生一次。
