import { test } from "node:test";
import assert from "node:assert/strict";
import { enforcePriorFindings } from "../src/worker.mjs";

const prior = "瞬时断连被判 Permanent；exhausted 在控制台不可达；stop 全局锁阻塞";

test("an approval without per-item findings cannot clear earlier findings", () => {
  const result = enforcePriorFindings({ approved: true, summary: "文档与实测一致" }, prior);
  assert.equal(result.approved, false);
  assert.match(result.summary, /未逐条确认上轮问题/);
});

test("an approval with any unresolved finding is rejected", () => {
  const result = enforcePriorFindings({ approved: true, summary: "ok", findings: [{ item: "Permanent", status: "resolved" }, { item: "stop", status: "unresolved" }] }, prior);
  assert.equal(result.approved, false);
});

test("an approval that resolves every item passes, and no prior review leaves it untouched", () => {
  const ok = enforcePriorFindings({ approved: true, summary: "ok", findings: [{ item: "Permanent", status: "resolved", evidence: "分类器已改为 Transient" }] }, prior);
  assert.equal(ok.approved, true);
  const fresh = enforcePriorFindings({ approved: true, summary: "ok" }, "");
  assert.equal(fresh.approved, true);
});
