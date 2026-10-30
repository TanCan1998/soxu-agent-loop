# 规则归属：谁定义、谁实现、谁校验

本文件说明 loop 仓库与目标项目（SOXU）之间「规则」的边界。
它解决的具体问题是：Issue/PR 的标题、标签、关闭语义曾在 loop 的 7 个文件里各写一份（59 处字面量），
于是「自动关闭的 Issue 不清标签」这类路径遗漏只能靠事后人工发现。

## 一句话

**目标项目提供参数与内容，loop 拥有工具行为规则。loop 读目标项目的配置，但不读目标项目对 loop 自身行为的定义。**

## 三层划分

| 层 | 归属 | 内容 | 例子 |
| --- | --- | --- | --- |
| 参数与内容 | **目标项目** | 项目事实：哪些路径受保护、跑什么检查命令、分支名、预算、模型路由、任务定义、Agent 上下文 | `automation/policy.json`、`automation/agent-models.json`、`AGENTS.md`、`agents/policies/*.md`、`tasks/*` |
| 工具行为规则 | **loop** | loop 自己怎么操作 GitHub 与 Git：状态标签语义、Issue/PR 标题语法、关闭引用、提交主题、分支命名、归档流程 | `automation/loop/src/rules.mjs` |
| 仓库守卫 | **目标项目** | 守住本仓库的历史与 PR 门槛（人工提交也要过），属于镜像而非定义 | SOXU 的 `scripts/check-issue-title.mjs`、`scripts/check-commit-msg.mjs` |

为什么守卫必须留在目标项目：GitHub Actions 只能跑在 PR 所在仓库，
而人工建 Issue、人工提交同样要拦。但这不构成「loop 运行期读取目标项目规则」的理由。

## 关键区分：CI 时契约测试 ≠ 运行时依赖

- **允许**：loop 的测试读目标项目的守卫脚本，断言「我生成的东西能通过它的校验」。漂移会在 loop 的 CI 里暴露。
- **禁止**：loop 在运行期读目标项目的守卫脚本来决定怎么写标题或提交。那会把拆分（loop 独立成仓库）退回到耦合。

对应实现：`automation/loop/tests/rules-contract.test.mjs`。

## loop 自己的提交也遵守同一套提交规范

两个仓库各自需要一份 `check-commit-msg.mjs`：SOXU 守 SOXU 的历史，loop 守 loop 的历史。
因此它们是**两份实现、同一份规范**，不是冗余。为避免静默漂移，loop 的测试会比较两边的
`COMMIT_TYPES` 与 `GITMOJI` 映射，任何一边改了而另一边没改都会失败。

## 唯一出口

所有 GitHub 写操作必须经 `process.mjs` 的 `gh()`：

- 子命令白名单（`GH_ALLOWED`）：只放行任务生命周期需要的读/写命令；
  `gh api` 只允许只读方法。`gh secret`、`gh workflow`、`gh repo delete` 等一律拒绝。
- 审计：每条放行/拒绝记录写入 `<目标项目>/.soxu/logs/gh.jsonl`（已被 gitignore）。

新增 GitHub 操作时，先加白名单项并说明用途，再改调用点；不允许绕开 `gh()` 直接 `run("gh", …)`。

## 参数文件里不该出现的东西

`automation/policy.json` 只放「项目所有者能决定的事」。曾有一个 `issueLabel` 字段本意是配置
「哪个标签代表可认领任务」，但它是 loop 的协议常量，写进项目参数后无人使用，成了死字段，
已于 2026-11-02 删除。判断标准：**换了项目需要改吗？** 需要 → 参数；不需要 → loop 的规则。
