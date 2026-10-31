/**
 * 守卫测试：Windows 的 pnpm 白名单必须跟随目标项目 policy 的 checks。
 *
 * 背景（2026-11-02）：policy.json 在 10-30 新增了
 * `pnpm --filter @soxu/desktop exec vite build`，而 process.mjs 的白名单仍是硬编码三条，
 * 于是 TASK-033 在 Windows 上跑检查时被判定 `Windows pnpm command not allowlisted` → blocked。
 * 这类漂移只会在 Windows 上、且只有真正跑到 checks 阶段才暴露。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { allowPolicyCommands, pnpmCommandAllowed } from "../src/process.mjs";
import { ROOT } from "../src/config.mjs";

test("内置命令始终允许，任意其它 pnpm 调用默认拒绝", () => {
  assert.equal(pnpmCommandAllowed(["check"]), true);
  assert.equal(pnpmCommandAllowed(["--version"]), true);
  assert.equal(pnpmCommandAllowed(["publish"]), false);
  assert.equal(pnpmCommandAllowed(["exec", "rm", "-rf", "/"]), false);
});

test("policy 声明的 pnpm 检查命令会被登记，其余 pnpm 命令仍被拒绝", () => {
  allowPolicyCommands([{ bin: "pnpm", args: ["--filter", "@soxu/desktop", "exec", "vite", "build"] }]);
  assert.equal(pnpmCommandAllowed(["--filter", "@soxu/desktop", "exec", "vite", "build"]), true);
  assert.equal(pnpmCommandAllowed(["--filter", "@soxu/desktop", "exec", "vite", "preview"]), false, "只放行声明过的那一条");
});

test("非 pnpm 的 check、畸形参数与超长参数不会被登记", () => {
  allowPolicyCommands([
    { bin: "cargo", args: ["test", "--workspace"] },
    { bin: "pnpm", args: [] },
    { bin: "pnpm", args: ["x".repeat(300)] },
    { bin: "pnpm", args: [123] },
    null,
  ]);
  assert.equal(pnpmCommandAllowed([]), false);
  assert.equal(pnpmCommandAllowed(["x".repeat(300)]), false);
  assert.equal(pnpmCommandAllowed(["test", "--workspace"]), false);
});

test("目标项目 policy.json 里的每条 pnpm 检查都能在 Windows 上通过白名单", async () => {
  const policy = JSON.parse(await readFile(join(ROOT, "automation", "policy.json"), "utf8"));
  const pnpmChecks = (policy.checks ?? []).filter((check) => check.bin === "pnpm");
  assert.ok(pnpmChecks.length > 0, "policy 至少应声明一条 pnpm 检查");
  allowPolicyCommands(policy.checks);
  for (const check of pnpmChecks) {
    assert.equal(pnpmCommandAllowed(check.args), true, "未被允许：pnpm " + check.args.join(" "));
  }
});

test("worker-worktree 在跑检查前登记 policy 命令（否则 Windows 上永远 blocked）", async () => {
  const source = await readFile(join(import.meta.dirname, "..", "src", "worker-worktree.mjs"), "utf8");
  assert.match(source, /allowPolicyCommands\(policy\.checks\)/, "runChecks 必须先登记 policy 命令");
});
