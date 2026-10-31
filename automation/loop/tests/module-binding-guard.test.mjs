/**
 * 守卫测试：拆分模块后最容易犯的两类错误，必须在 CI 就暴露。
 *
 * 1) 转发式 re-export（`export { x } from "./y.mjs"`）不会在本模块创建绑定，
 *    但模块内部仍在调用 x —— 只有跑到那条分支才抛 ReferenceError。
 * 2) 拆分/精简 import 时漏掉仍在使用的名字（例如把 `stat` 从 fs/promises 的导入里删掉）。
 *
 * 两类错误的共同点：`node --check`、模块加载、多数单元测试全部通过。
 * 2026-11-02 TASK-033（#143）先后被这两类问题卡在 worktree 阶段：
 * 先是 `beginBlockedRetry is not defined`，修好后又变成 `stat is not defined`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");
const BACKTICK = String.fromCharCode(96);

/** 去掉注释与字符串字面量，避免把提示文本当成标识符。 */
export function stripNonCode(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(new RegExp(BACKTICK + "(?:\\\\[\\s\\S]|[^" + BACKTICK + "\\\\])*" + BACKTICK, "g"), "S")
    .replace(/'(?:\\.|[^'\\])*'/g, "S")
    .replace(/"(?:\\.|[^"\\])*"/g, "S");
}

/** 文件里声明或导入的名字。 */
export function declaredNames(code) {
  const names = new Set();
  for (const m of code.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/^import\s+(?:\*\s+as\s+)?\{([^}]+)\}/gm)) {
    for (const part of m[1].split(",")) {
      const name = part.split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  for (const m of code.matchAll(/^import\s+([A-Za-z_$][\w$]*)\s+from/gm)) names.add(m[1]);
  // 函数/箭头函数/catch 的参数也是本地绑定（例如 new Promise((resolve, reject) => …)）。
  const addParams = (list) => {
    for (const part of list.split(",")) {
      const name = part.trim().split("=")[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  };
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) addParams(m[1]);
  // 单参数箭头函数：new Promise(resolve => …)
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) names.add(m[1]);
  // 类方法/对象方法简写：async resolve(id) { … }
  const CONTROL = new Set(["if", "for", "while", "switch", "catch", "return", "function", "do", "try", "else", "with"]);
  for (const m of code.matchAll(/^\s*(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/gm)) {
    if (!CONTROL.has(m[1])) names.add(m[1]);
  }
  for (const m of code.matchAll(/\bfunction\s*[A-Za-z_$\w$]*\s*\(([^()]*)\)/g)) addParams(m[1]);
  for (const m of code.matchAll(/\bcatch\s*\(([^()]*)\)/g)) addParams(m[1]);
  return names;
}

/** 必须以导入或本地声明形式出现的 API 名（内置模块 + 本仓库导出）。 */
export const API_NAMES = [
  "stat", "readFile", "writeFile", "readdir", "mkdir", "rm", "open", "realpath", "access", "copyFile",
  "join", "resolve", "dirname", "basename", "relative",
  "spawn", "fork", "execFile", "execSync", "spawnSync",
  "createHash", "randomBytes", "timingSafeEqual",
  "networkInterfaces", "EventEmitter", "pathToFileURL", "fileURLToPath",
  "safeFailureMessage", "classifyFailure", "LoopFailure", "isRecoverable",
  "applyStateLabel", "completeMergedIssue", "staleLabels",
  "issueTitle", "validateIssueTitle", "prTitle", "commitSubject", "closesIssue", "closingReferences",
  "ghCommandAllowed", "cleanLine", "inspectExternalLocks",
];

/** 在给定源码里找出「被当作 API 使用却没有导入/声明」的名字。 */
export function missingBindings(source, apiNames = API_NAMES) {
  const code = stripNonCode(source);
  const declared = declaredNames(code);
  return apiNames.filter((name) => {
    if (declared.has(name)) return false;
    const pattern = new RegExp("(^|[^.\\w$])" + name + "\\s*[.(]", "m");
    return pattern.test(code);
  });
}

test("检测器自身有效：缺 import 的 API 会被指出", () => {
  const broken = ["export function f() {", "  return stat(\"x\");", "}"].join("\n");
  assert.deepEqual(missingBindings(broken), ["stat"]);
  const fixed = ["import { stat } from \"node:fs/promises\";", "export function f() {", "  return stat(\"x\");", "}"].join("\n");
  assert.deepEqual(missingBindings(fixed), []);
});

test("所有 src 模块用到的 API 都已导入或声明", async () => {
  const offenders = [];
  for (const file of (await readdir(SRC)).filter((name) => name.endsWith(".mjs"))) {
    const source = await readFile(join(SRC, file), "utf8");
    const missing = missingBindings(source);
    if (missing.length) offenders.push(file + " -> " + missing.join(", "));
  }
  assert.deepEqual(offenders, [], "以下模块使用了未导入的 API，运行到对应分支会抛 ReferenceError：" + offenders.join(" | "));
});

/** 取出一个模块里所有转发式 re-export 的名字（export { a, b } from "..."）。 */
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

function usedOutsideImportExport(source, name) {
  const pattern = new RegExp("\\b" + name + "\\b");
  return source
    .split("\n")
    .filter((line) => !/^\s*(import|export)\b/.test(line))
    .some((line) => pattern.test(line));
}

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
  for (const file of (await readdir(SRC)).filter((name) => name.endsWith(".mjs"))) {
    const source = await readFile(join(SRC, file), "utf8");
    for (const name of reExportedNames(source)) {
      if (usedOutsideImportExport(source, name) && !importedLocally(source, name)) offenders.push(file + " -> " + name);
    }
  }
  assert.deepEqual(offenders, [], "转发导出不会创建本地绑定：" + offenders.join(", "));
});

test("worker.mjs 的纯状态函数既可从自身导入，也在本模块内可用", async () => {
  const source = await readFile(join(SRC, "worker.mjs"), "utf8");
  const names = ["prepareCheckRepair", "beginBlockedRetry", "applyReviewRejection", "enforcePriorFindings", "releasePinnedModelsAfterManualStop", "pinTaskModels"];
  for (const name of names) {
    assert.ok(importedLocally(source, name), "worker.mjs 必须本地 import " + name);
    assert.ok(usedOutsideImportExport(source, name), "worker.mjs 应当在状态机里实际使用 " + name);
  }
  const worker = await import("../src/worker.mjs");
  for (const name of names) assert.equal(typeof worker[name], "function", "worker.mjs 必须导出 " + name);
});
