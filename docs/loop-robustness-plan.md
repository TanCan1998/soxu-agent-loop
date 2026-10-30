# Loop 健壮性与三轨优化方案（2026-10-30）

基于 V4 首轮实战数据 + 外部实践调研。

## 一、外部调研发现

### 1. 并行 Agent 的冲突处理（Factory）

> "Coding agent merge conflict resolution can save time when two branches edit the same code,
> but a clean Git index proves only that the conflict markers are gone. The final file still has
> to preserve the intent of both changes."

关键做法：

1. **固定 base**：记录目标分支、源分支、精确 commit，从干净 worktree 复现
2. **给 agent 完整上下文**：PR 描述、验收标准、受影响文件的最近改动、ownership 规则
3. **分类处理**：生成文件要标识来源；lockfile 要给包管理器和批准的重生成命令
4. **先解行为再解语法**：读双方和共同祖先，理解意图，不整边丢弃
5. **保持范围窄**：不做无关格式化/重构
6. **不兼容的产品决策要停下报告**，不要猜
7. **验证组合行为**：搜冲突标记、看 staged diff、跑最小测试

### 2. `git rerere`（reuse recorded resolution）

> "Once enabled, it will record conflicts and the resolutions that you create.
> The next time you encounter the same conflict, your resolution will be applied automatically."

我们的 `App.vue` 冲突会反复出现（同样的顶栏按钮插入点），rerere 正好对症。

### 3. Nx Self-Healing CI

- CI 失败时**自动分析并提议修复**，而不是直接阻塞
- 用 `if: always()` 保证修复步骤必跑，成功时自动 no-op
- **默认分支与 `dev`/`stable`/`canary` 永不生成修复**——保护集成分支

### 4. Anthropic 多 Agent 研究系统

> "Multi-agent systems work mainly because they help spend enough tokens to solve the problem...
> token usage by itself explains 80% of the variance... multi-agent systems burn through tokens fast,
> agents typically use about 4× more tokens than chat interactions."

**启示**：并行不是免费午餐。我们的实测也印证了——4 路并行的净效率低于串行，因为冲突成本超过了并行收益。

---

## 二、三轨现状诊断

### 现有实现

```js
// advisory.mjs
const PATHS = {
  product: [
    ['docs/product/prd.md', 9000],
    ['docs/development/roadmap.md', 3000],
    ['docs/design/gpt-inspired-ui.md', 2800],
    ['AGENTS.md', 2800],
  ],
  quality: [
    ['LESSONS.md', 7500],
    ['agents/policies/quality-gates.md', 2800],
    ['docs/development/agent-loop.md', 2800],
    ['AGENTS.md', 2800],
  ],
};
```

### 三个问题

**问题 1｜证据源是静态文档**

只读固定文件，不读实际代码、PR、CI 结果、测试覆盖。于是只能给"文档与实现是否一致"这类元层面判断。

实测报告（quality，2026-10-28）的结论全是这类：
- "复盘机制尚未闭环：单日约 12 个 fix PR 但 LESSONS.md 零条目"
- "任务状态机与分支生命周期是重复缺陷热点"
- "main 分支在 2026-10-27 发生过历史重写，SHA 级证据链受损"

这些判断本身没错，但**对"下一件事该做什么"没有指导价值**。

**问题 2｜观察过时**

报告停在 2026-10-28 09:35，只覆盖 10-27 的数据。而 10-29～10-30 期间合并了 6 个 V4 切片、修了 5 个 loop 缺陷、发生 12 次人工介入——报告完全没覆盖。

原因是**没有时间窗口概念**，也没有定期触发。

**问题 3｜证据路径会失效**

`docs/design/gpt-inspired-ui.md` 是 V3 时代的文件，V4 已经有 `docs/design/UIUX/V4/DESIGN.md`。
证据源写死后不会跟着项目演进。

---

## 三、优化方案

### L1｜冲突自动恢复（最高优先）

| 改动 | 做法 |
|---|---|
| **rerere 默认开启** | `git config --global rerere.enabled true` + `rerere.autoupdate true`，并在 worktree 创建时确保生效 |
| **冲突分类** | lockfile（`Cargo.lock`/`pnpm-lock.yaml`）→ 取 base 版本 + 重生成；生成文件 → 重新生成；源码 → 交 agent |
| **自动 rebase 重试** | merge 阶段检测 `CONFLICTING` → `git rebase origin/<base>` → 成功则重跑 checks 重试 merge |
| **冲突交给 Developer** | rebase 失败且冲突 < 3 文件 → 派 Developer Agent 解决，附完整上下文（见下） |
| **上下文注入** | 给 agent 的 prompt 补：PR 描述、验收标准、冲突文件最近 5 次提交、两边意图摘要 |
| **不可解则停下** | 冲突 > 3 文件或涉及产品决策 → blocked，评论里列冲突文件 + 块数 + 建议 |

### L2｜自愈 CI + 并行策略

| 改动 | 做法 |
|---|---|
| **checks 失败自动修复** | 借鉴 Nx：checks 失败 → 派 Developer 分析失败原因并修复（上限 2 次），而不是直接 blocked |
| **保护集成分支** | `dev` 上永不自动修复（只允许 PR 修复），与 Nx 一致 |
| **并行度默认 2** | `maxConcurrentAgents: 2`，不是 4 |
| **冲突预检** | 待跑切片的 `scope` 文件集有交集 → 串行 |
| **前端强制串行** | `App.vue` 挂载点机制落地前，前端切片一次只跑一个 |
| **脏状态清理** | runner/dashboard 启动时扫 `status=running` 但无进程的 checkpoint → 改 `paused` |

### L3｜三轨重做

**核心改动：证据源从"静态文档"改为"文档 + 实时结构化数据"**

```js
// 新的证据采集
async function collectEvidence(lane, { since = 7 天前 }) {
  const common = [
    readFile('AGENTS.md'),
    dashboardStatus(),          // tasks / roadmap / agents / log
    recentPRs(since),           // 合并/关闭/冲突的 PR 列表
    recentIssues(since),        // 标签流转、blocked 原因
  ];
  if (lane === 'product') return [
    ...common,
    readFile('docs/product/prd.md'),
    readFile('docs/design/UIUX/V4/interaction-decisions.md'),  // 路径动态发现
    milestoneProgress(),        // 各里程碑 total/merged
    deliveredSince(since),      // 最近 N 天交付了什么
  ];
  if (lane === 'quality') return [
    ...common,
    readFile('LESSONS.md'),
    ciResults(since),           // CI 通过率、失败原因分布
    blockedReasons(since),      // 阻塞原因聚类
    conflictStats(since),       // 冲突文件/块数统计
    testCountTrend(),           // 测试数量变化
  ];
}
```

**输出格式强制化**

每条 finding 必须带四要素，缺一不可：

```json
{
  "title": "简短结论",
  "evidence": ["文件:行号", "PR #123", "命令输出"],
  "impact": "影响哪个切片/流程，量化",
  "action": "具体改哪个文件、加什么测试、预计工作量",
  "confidence": "high|medium|low"
}
```

**时间窗口 + 定期触发**

- 每次运行带 `since`（默认 7 天）
- dashboard 每 24 小时自动跑一次（可配置）
- 报告保留最近 30 份，旧的归档

**路径动态发现**

不写死 `docs/design/gpt-inspired-ui.md`，改为 glob 匹配最新版本（`docs/design/**/DESIGN.md` 取 mtime 最新）。

---

## 四、预期收益

| 指标 | 现状（V4 首轮） | L1+L2 后预期 |
|---|---|---|
| 人工介入次数 | 12 次 / 10 切片 | ≤ 3 次 |
| 冲突导致的重做 | 2 个切片 | 0 |
| 并行有效度 | 4 路 → 净效率低于串行 | 2 路 → 稳定产出 |
| 三轨报告可用性 | 元层面判断，无行动项 | 每条带可执行建议 |

## 五、实施顺序

```
L1（冲突自动恢复）  → 必须先做，否则启动就会重现
L2（自愈 + 并行策略）→ 再做，防止再次撞车
L3（三轨重做）      → 可与 L1/L2 并行，但要在下一轮启动前完成
```
