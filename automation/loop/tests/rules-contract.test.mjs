/**
 * 契约测试：loop 生成的产物必须通过目标项目的守卫。
 *
 * 这是「CI 时校验」，不是「运行期依赖」：loop 运行时不读目标项目的规则，
 * 只在测试里确认自己生成的东西能被对方接受。详见 docs/rules-ownership.md。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { ROOT } from "../src/config.mjs";
import * as rules from "../src/rules.mjs";
import { ghCommandAllowed } from "../src/process.mjs";
import { staleLabels } from "../src/lifecycle.mjs";

const souxCheckIssueTitle = join(ROOT, "scripts", "check-issue-title.mjs");
const souxCheckCommitMsg = join(ROOT, "scripts", "check-commit-msg.mjs");
const loopCheckCommitMsg = join(import.meta.dirname, "..", "..", "..", "scripts", "check-commit-msg.mjs");

test("生成的 Issue 标题能通过目标项目的标题守卫", { skip: !existsSync(souxCheckIssueTitle) && "目标项目缺少 scripts/check-issue-title.mjs" }, async () => {
  const source = await readFile(souxCheckIssueTitle, "utf8");
  const pattern = /const GOOD = (\/.*\/);/.exec(source);
  assert.ok(pattern, "守卫脚本里必须能找到 GOOD 正则；找不到说明它改了结构，需同步本测试");
  const good = eval(pattern[1]);
  for (const [milestone, taskId, title] of [
    ["M0", "TASK-001", "示例任务"],
    ["M1", "TASK-143", "产品净化：移除假交互"],
    ["M4", "TASK-999", "发布检查"],
  ]) {
    const generated = rules.issueTitle(milestone, taskId, title);
    assert.equal(good.test(generated), true, "生成标题必须通过目标项目守卫：" + generated);
    assert.equal(rules.validateIssueTitle(generated), null);
  }
});

test("生成的提交主题能通过目标项目的提交守卫", { skip: !existsSync(souxCheckCommitMsg) && "目标项目缺少 scripts/check-commit-msg.mjs" }, async () => {
  const { validateCommitMessage } = await import(pathToFileURL(souxCheckCommitMsg).href);
  const messages = [
    rules.commitSubject(143),
    rules.commitSubject(1),
    rules.archiveCommitSubject("TASK-033", 143),
    rules.orphanArchiveCommitSubject(3),
  ];
  for (const message of messages) {
    assert.equal(validateCommitMessage(message), null, "提交主题必须通过目标项目守卫：" + message);
  }
});

test("PR 标题与 Runner 提交主题同源，不会各自漂移", () => {
  for (const issue of [1, 143, 9999]) {
    assert.equal(rules.prTitle(issue), rules.commitSubject(issue));
  }
});

test("PR 正文的关闭引用能被 loop 自己解析回同一个 Issue", () => {
  const body = rules.closingBody(143, "摘要");
  assert.equal(rules.closesIssue(body, 143), true);
  assert.equal(rules.closesIssue(body, 144), false);
  assert.deepEqual(rules.closingReferences(body), [143]);
});

test("两个仓库的提交规范语义一致（COMMIT_TYPES 与 GITMOJI 映射相同）", { skip: !existsSync(loopCheckCommitMsg) && "loop 仓库缺少 scripts/check-commit-msg.mjs" }, async () => {
  const local = await import(pathToFileURL(join(import.meta.dirname, "..", "..", "..", "scripts", "check-commit-msg.mjs")).href);
  assert.deepEqual([...local.COMMIT_TYPES], [...(await import(pathToFileURL(loopCheckCommitMsg).href)).COMMIT_TYPES]);
  assert.deepEqual({ ...local.GITMOJI }, { ...(await import(pathToFileURL(loopCheckCommitMsg).href)).GITMOJI });
  if (existsSync(souxCheckCommitMsg)) {
    const target = await import(pathToFileURL(souxCheckCommitMsg).href);
    // 两份实现必须表达同一套规范：任一边新增 type/emoji 而另一边没跟上，这里就失败。
    assert.deepEqual([...target.COMMIT_TYPES], [...local.COMMIT_TYPES], "loop 与目标项目的提交类型必须一致");
    assert.deepEqual({ ...target.GITMOJI }, { ...local.GITMOJI }, "loop 与目标项目的 gitmoji 映射必须一致");
  }
});

test("标签常量只有 rules.mjs 一处定义，其它源码不得再写 agent:* 字面量", async () => {
  const dir = join(import.meta.dirname, "..", "src");
  const offenders = [];
  for (const file of await readdir(dir)) {
    if (!file.endsWith(".mjs") || file === "rules.mjs") continue;
    const source = await readFile(join(dir, file), "utf8");
    // 允许出现在注释里说明语义；只禁止实际的字符串字面量。
    const literal = /["']agent:(?:ready|waiting|in-progress|paused|blocked|pr|release)["']/.exec(source);
    if (literal) offenders.push(file + " -> " + literal[0]);
  }
  assert.deepEqual(offenders, [], "以下文件仍在硬编码标签字面量，请改用 rules.mjs 的 TASK_STATE/LABELS：" + offenders.join(", "));
});

test("状态互斥只有一处实现：Runner 与看板都走 lifecycle.applyStateLabel", async () => {
  const dir = join(import.meta.dirname, "..", "src");
  for (const file of ["github.mjs", "queue-order.mjs"]) {
    const source = await readFile(join(dir, file), "utf8");
    assert.match(source, /applyStateLabel/, file + " 必须复用 lifecycle.applyStateLabel");
    assert.doesNotMatch(source, /for \(const name of STATE_LABELS\)/, file + " 不得再自行计算状态差集");
  }
});

test("完成态只清未完成标签，agent:release 等非状态标签保持不动", () => {
  assert.deepEqual(
    staleLabels([{ name: "agent:pr" }, { name: "agent:ready" }, { name: "agent:release" }, { name: "enhancement" }]).sort(),
    ["agent:pr", "agent:ready"],
  );
  assert.deepEqual(staleLabels([]), []);
  assert.deepEqual(staleLabels([{ name: "agent:release" }]), []);
});

test("gh 白名单只放行任务生命周期需要的命令", () => {
  const allowed = [
    ["pr", "view", "1"], ["pr", "list"], ["pr", "create"], ["pr", "merge", "1"],
    ["issue", "view", "1"], ["issue", "list"], ["issue", "create"],
    ["issue", "edit", "1"], ["issue", "close", "1"], ["issue", "comment", "1"],
    ["label", "create", "agent:ready"], ["repo", "view"], ["run", "list"],
    ["release", "create", "v0.1.0"], ["api", "repos/{owner}/{repo}/branches/main/protection"],
  ];
  const denied = [
    ["secret", "set"], ["workflow", "run"], ["repo", "delete"],
    ["api", "repos/x/y", "--method", "DELETE"],
    ["api", "repos/x/y", "-X", "POST"],
    ["pr"], [], [""],
  ];
  for (const args of allowed) assert.equal(ghCommandAllowed(args), true, "应放行：" + args.join(" "));
  for (const args of denied) assert.equal(ghCommandAllowed(args), false, "应拒绝：" + args.join(" "));
});
