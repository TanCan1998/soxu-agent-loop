/**
 * 守卫测试：拆分模块后「re-export 不等于本地绑定」这类错误必须在 CI 就暴露。
 *
 * 背景（2026-11-02）：worker.mjs 把纯状态函数挪进 worker-recovery.mjs 后，
 * 只写了 `export { … } from "./worker-recovery.mjs"`，而模块内部仍在直接调用它们。
 * 语法检查、导入检查都通过，只有真正跑到 blocked 恢复分支时才抛
 * `beginBlockedRetry is not defined` —— #143 就是这样卡在 worktree 阶段。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");

/** 取出一个模块里所有「转发式 re-export」的名字（export { a, b } from "..."）。 */
function reExportedNames(source) {
  const names = [];
  for (const match of source.matchAll(/^export\s*\{([^}]+)\}\s*from\s*["'][^"']+["'];?/gm)) {
    for (const raw of match[1].split(",")) {
      const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

/** 该名字是否在文件里被「当作值使用」（排除 import/export 语句本身）。 */
function usedOutsideImportExport(source, name) {
  const pattern = new RegExp("\\b" + name + "\\b");
  return source
    .split("\n")
    .filter((line) => !/^\s*(import|export)\b/.test(line) && !/^\s*\}?\s*(from\s*)?["'][^"']+["'];?\s*$/.test(line))
    .some((line) => pattern.test(line));
}

/** 该名字是否被本地 import（import { … } from）。 */
function importedLocally(source, name) {
  for (const match of source.matchAll(/^import\s*\{([^}]+)\}\s*from/gm)) {
    for (const raw of match[1].split(",")) {
      if (raw.trim().split(/\s+as\s+/).pop()?.trim() === name) return true;
    }
  }
  return false;
}

test("转发式 re-export 的名字，若在本模块被调用就必须同时本地 import", async () => {
  const offenders = [];
  for (const file of ["worker.mjs", "dashboard.mjs", "dashboard-coordinator.mjs", "lifecycle.mjs", "github.mjs", "queue-order.mjs"]) {
    const source = await readFile(join(SRC, file), "utf8");
    for (const name of reExportedNames(source)) {
      if (usedOutsideImportExport(source, name) && !importedLocally(source, name)) {
        offenders.push(file + " -> " + name);
      }
    }
  }
  assert.deepEqual(offenders, [], "以下名字被转发导出但未本地导入，运行到对应分支会抛 ReferenceError：" + offenders.join(", "));
});

test("worker.mjs 的纯状态函数既可从自身导入，也在本模块内可用", async () => {
  const source = await readFile(join(SRC, "worker.mjs"), "utf8");
  const names = ["prepareCheckRepair", "beginBlockedRetry", "applyReviewRejection", "enforcePriorFindings", "releasePinnedModelsAfterManualStop", "pinTaskModels"];
  for (const name of names) {
    assert.ok(importedLocally(source, name), "worker.mjs 必须本地 import " + name);
    assert.ok(usedOutsideImportExport(source, name), "worker.mjs 应当在状态机里实际使用 " + name);
  }
  // 对外导入路径不变：测试与 cli.mjs 仍从 worker.mjs 取这些函数。
  const worker = await import("../src/worker.mjs");
  for (const name of names) assert.equal(typeof worker[name], "function", "worker.mjs 必须导出 " + name);
});
