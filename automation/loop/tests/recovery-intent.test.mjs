import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRecoveryIntent, selectRecoveryCandidates } from "../src/recovery-intent.mjs";

const paused = (n, timestamp, local = false, status = "paused") => ({
  status, local, updatedAt: timestamp, issue: { number: n, title: `test ${n}` }, phase: "develop", reason: "quota"
});
const states = [
  paused(101, "2026-10-26T01:00:00Z"),
  paused(102, "2026-10-26T03:00:00Z", true),
  paused(103, "2026-10-26T02:00:00Z"),
  paused(104, "2026-10-26T04:00:00Z", false, "running"),
  paused(105, "2026-10-26T05:00:00Z", false, "blocked")
];

test("natural language identifies the most recent task without contacting a model", () => {
  for (const text of ["继续 SOXU", "恢复上次因额度或网络问题中断的任务", "恢复最近一个暂停任务", "Resume last SOXU task"]) {
    assert.deepEqual(parseRecoveryIntent(text), { scope: "latest" });
    assert.deepEqual(selectRecoveryCandidates(states, parseRecoveryIntent(text)).map(s => s.issue.number), [102]);
  }
});

test("explicit issue reference and all-scope are distinct", () => {
  for (const text of ["恢复 Issue 123", "恢复 issue #123", "恢复 #123", "恢复任务编号123", "恢复 123"]) {
    assert.deepEqual(parseRecoveryIntent(text), { scope: "issue", issueNumber: 123 });
  }
  assert.deepEqual(parseRecoveryIntent("恢复所有暂停的任务"), { scope: "all" });
  assert.deepEqual(selectRecoveryCandidates(states, parseRecoveryIntent("恢复所有暂停的任务")).map(s => s.issue.number), [102,103,101]);
  assert.deepEqual(selectRecoveryCandidates(states, parseRecoveryIntent("继续 SOXU"), { localOnly: true }).map(s => s.issue.number), [102]);
});

test("no matches never creates a fallback task", () => {
  assert.deepEqual(selectRecoveryCandidates(states, { scope: "issue", issueNumber: 101 }).map(s => s.issue.number), [101]);
  assert.deepEqual(selectRecoveryCandidates([], { scope: "latest" }), []);
  assert.throws(() => selectRecoveryCandidates(states, { scope: "issue", issueNumber: 104 }), /暂停检查点/);
  assert.throws(() => selectRecoveryCandidates(states, { scope: "issue", issueNumber: 999 }), /暂停检查点/);
});

test("ambiguous, negative and destructive prompts fail closed", () => {
  for (const text of ["删掉所有分支", "不要恢复 SOXU", "恢复 Issue 123 和 Issue 456", "恢复所有 Issue 123", "恢复 SOXU 并删除代码", "hello world", "继续", "恢复 Issue 0"]) {
    assert.throws(() => parseRecoveryIntent(text), undefined, text);
  }
});
