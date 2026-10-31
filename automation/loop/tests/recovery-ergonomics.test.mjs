/**
 * 守卫测试：两个反复出现的人工介入点必须自动化。
 *
 * 1. blockedRecoveryCount 到上限后任务被跳过，此前只能手工改检查点（本轮改了 2 次）
 *    → 现在有 `cli.mjs reset-blocked --issue N`，显式人工调用。
 * 2. 每个 worktree 每次 resume 都重装依赖（30–60s）→ pnpm install 加 --prefer-offline。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resetBlockedRecovery } from "../src/blocked-recovery.mjs";
import { pnpmCommandAllowed } from "../src/process.mjs";

const SRC = join(import.meta.dirname, "..", "src");

test("resetBlockedRecovery 只清计数，不动状态与阶段", () => {
  const state = { status: "blocked", phase: "merge", blockedRecoveryCount: 2, commit: "a".repeat(40), branch: "agent/github-issue-1-x" };
  const outcome = resetBlockedRecovery(state);
  assert.equal(outcome.reset, true);
  assert.equal(outcome.before, 2);
  assert.equal(state.blockedRecoveryCount, 0);
  assert.equal(state.status, "blocked", "状态由人工决定何时恢复，重置计数不应顺带改状态");
  assert.equal(state.phase, "merge");
  assert.equal(state.commit, "a".repeat(40));
  assert.equal(state.branch, "agent/github-issue-1-x");
});

test("resetBlockedRecovery 对已是 0 或非法输入不报错、不改动", () => {
  const zero = { blockedRecoveryCount: 0 };
  assert.deepEqual(resetBlockedRecovery(zero), { reset: false, reason: "already-zero", before: 0 });
  const missing = {};
  assert.deepEqual(resetBlockedRecovery(missing), { reset: false, reason: "already-zero", before: 0 });
  assert.equal(missing.blockedRecoveryCount, undefined, "没有该字段时不要凭空写入");
  assert.equal(resetBlockedRecovery(null).reason, "invalid-state");
});

test("CLI 暴露 reset-blocked，且要求显式 --issue", async () => {
  const source = await readFile(join(SRC, "cli.mjs"), "utf8");
  assert.match(source, /case "reset-blocked"/, "必须有 reset-blocked 命令");
  assert.match(source, /reset-blocked 需要 --issue/, "缺参数时要给出明确提示");
  assert.match(source, /reset-blocked Clear the blocked-retry counter/, "HELP 里要能查到");
});

test("worker 的 pnpm install 带 --prefer-offline，且 Windows 白名单放行", async () => {
  const source = await readFile(join(SRC, "worker.mjs"), "utf8");
  const installs = [...source.matchAll(/run\("pnpm", \[([^\]]+)\]/g)].map((m) => m[1]);
  assert.ok(installs.length >= 3, "应覆盖 install / recoveryInstall / 冲突后安装三处");
  for (const args of installs) assert.match(args, /--prefer-offline/, "pnpm install 必须带 --prefer-offline：" + args);
  assert.equal(pnpmCommandAllowed(["install", "--no-frozen-lockfile", "--ignore-scripts", "--prefer-offline"]), true);
});
