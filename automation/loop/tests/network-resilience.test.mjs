/**
 * 守卫测试：网络抖动不能被当成任务失败。
 *
 * 背景（2026-10-31）：TASK-034 已通过检查与评审、PR 已创建，合并阶段一次
 * `gh pr view` 返回 `unexpected EOF`（TLS 抖动）就被判成 blocked。
 * 合并阶段本来就要反复轮询，单次网络错误应当重试或暂停，而不是把任务判死。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, isRecoverable } from "../src/errors.mjs";
import { retryTransient } from "../src/worker-pr.mjs";

test("gh 的 EOF / TLS 抖动归类为 network 且可恢复", () => {
  const samples = [
    "gh pr view https://github.com/a/b/pull/1 --json state exit=1\nunexpected EOF",
    'Post "https://api.github.com/graphql": net/http: TLS handshake timeout',
    "stream error: stream ID 1; INTERNAL_ERROR",
    "socket hang up",
    "early EOF",
  ];
  for (const message of samples) {
    const failure = classifyFailure(new Error(message));
    assert.equal(failure.kind, "network", "应归类为 network：" + message);
    assert.equal(isRecoverable(failure), true, "网络错误必须可恢复：" + message);
  }
});

test("真正的业务失败仍然是 failure，不会被当成网络问题重试", () => {
  const failure = classifyFailure(new Error("pr-not-ready"));
  assert.equal(failure.kind, "failure");
  assert.equal(isRecoverable(failure), false);
});

test("retryTransient 只重试网络错误，成功后返回结果", async () => {
  const sleeps = [];
  let calls = 0;
  const result = await retryTransient(async () => {
    calls += 1;
    if (calls < 3) throw new Error("unexpected EOF");
    return "ok";
  }, { attempts: 3, baseDelayMs: 10, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [10, 20], "退避应按次数递增");
});

test("retryTransient 不重试非网络错误", async () => {
  let calls = 0;
  await assert.rejects(
    () => retryTransient(async () => { calls += 1; throw new Error("invalid-body"); }, { attempts: 3, sleep: async () => {} }),
    /invalid-body/,
  );
  assert.equal(calls, 1, "业务错误必须立刻抛出");
});

test("retryTransient 用尽次数后抛出最后一次错误", async () => {
  let calls = 0;
  await assert.rejects(
    () => retryTransient(async () => { calls += 1; throw new Error("unexpected EOF"); }, { attempts: 2, sleep: async () => {} }),
    /unexpected EOF/,
  );
  assert.equal(calls, 2);
});
