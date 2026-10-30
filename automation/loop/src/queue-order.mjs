import { readdir, readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { dataRoot } from "./config.mjs";
// 标签清单只有一份（rules.mjs）。rules 不 import 任何运行模块，因此不会再有循环依赖。
import { STATE_LABELS, TASK_STATE } from "./rules.mjs";

const ORDER_FILE = "queue-order.json";

const pathOf = root => join(dataRoot(root), "intake", ORDER_FILE);

/** 用户自定义的 issue 处理顺序（数字数组）。文件缺失或损坏时返回空数组。 */
export async function readQueueOrder(root) {
  try {
    const data = JSON.parse(await readFile(pathOf(root), "utf8"));
    const order = Array.isArray(data?.order) ? data.order : [];
    return order.filter(n => Number.isSafeInteger(n) && n > 0);
  } catch { return []; }
}

export async function writeQueueOrder(root, order) {
  const clean = [...new Set(order.filter(n => Number.isSafeInteger(n) && n > 0))];
  const dir = join(dataRoot(root), "intake");
  await mkdir(dir, { recursive: true });
  const target = pathOf(root);
  const tmp = target + "." + process.pid + ".tmp";
  await writeFile(tmp, JSON.stringify({ version: 1, order: clean }, null, 2));
  await rename(tmp, target);
  return clean;
}

/** 已归档（tasks/done）的任务 id：视为前置依赖已满足。 */
export async function doneTaskIds(root, { execute = null, wanted = null } = {}) {
  let archived;
  try {
    const names = await readdir(join(root, "tasks", "done"));
    archived = new Set(names.flatMap(n => n.match(/TASK-\d{3,}/g) ?? []));
  } catch { return null; }
  // 只读目录会留下一个窗口期：任务已合并进集成分支、但 cleanup 还没把它从
  // tasks/backlog 归档到 tasks/done（dashboard 每 60 秒跑一次），
  // 这段时间里依赖它的需求会被误判为「依赖缺失」。
  // 传入 execute 与 wanted 时，再补一份「已关闭且 PR 有合入记录」的来源。
  if (!execute || !wanted?.length) return archived;
  const pending = wanted.filter(id => !archived.has(id));
  if (!pending.length) return archived;
  try {
    const issues = JSON.parse((await execute("gh", ["issue", "list", "--state", "all", "--limit", "1000", "--json", "number,title,state"], { cwd: root, timeoutMs: 30000 })).stdout);
    const closed = [...issues].filter(i => i.state === "CLOSED");
    if (!closed.length) return archived;
    const prs = JSON.parse((await execute("gh", ["pr", "list", "--state", "merged", "--limit", "1000", "--json", "body"], { cwd: root, timeoutMs: 30000 })).stdout);
    const merged = new Set();
    const re = /(?:^|\n)\s*(?:closes|closed|close|fixes|fixed|fix|resolves|resolved|resolve)\s+#(\d+)\b/gim;
    for (const pr of prs) for (const m of String(pr.body ?? "").matchAll(re)) merged.add(Number(m[1]));
    for (const issue of closed) {
      if (!merged.has(issue.number)) continue;
      for (const id of String(issue.title ?? "").match(/TASK-\d{3,}/g) ?? []) {
        if (pending.includes(id)) archived.add(id);
      }
    }
  } catch { /* gh 失败时退回纯本地判断，不让「设就绪」整体失败 */ }
  return archived;
}

/**
 * 按用户顺序排列：出现在 order 里的按 order 索引，
 * 其余保持原有相对顺序排在后面（稳定排序）。
 */
export function sortByQueueOrder(items, order, key = item => item.number) {
  if (!order?.length) return items;
  const rank = new Map(order.map((n, i) => [n, i]));
  const fallback = items.length + 1;
  return [...items].sort((a, b) => (rank.get(key(a)) ?? fallback) - (rank.get(key(b)) ?? fallback));
}

/**
 * 直接给已创建的 Issue 打/撤 agent:ready。
 * 打之前先做依赖校验（issue 正文/标题里的 TASK-xxx 必须已归档到 tasks/done）；
 * 校验不通过只返回原因，不修改远端标签。
 */
export async function setIssueReady(root, number, ready, { execute }) {
  if (!Number.isSafeInteger(number) || number <= 0) throw Object.assign(new Error("invalid-issue"), { status: 400 });
  if (typeof ready !== "boolean") throw Object.assign(new Error("invalid-choice"), { status: 400 });
  if (!ready) {
    await execute("gh", ["issue", "edit", String(number), "--remove-label", TASK_STATE.ready], { cwd: root, timeoutMs: 30000, allowFailure: true });
    return { ok: true, number, ready: false, missing: [] };
  }
  const view = JSON.parse((await execute("gh", ["issue", "view", String(number), "--json", "number,title,body,labels,state"], { cwd: root, timeoutMs: 30000 })).stdout);
  if (view.state !== "OPEN") return { ok: false, number, ready: false, missing: [], reason: "issue-closed" };
  const { dependencyIds } = await import("./dashboard-intake.mjs");
  const required = dependencyIds(String(view.title ?? "") + "\n" + String(view.body ?? ""));
  const done = await doneTaskIds(root, { execute, wanted: required });
  if (!done) return { ok: false, number, ready: false, missing: required, reason: "tasks-done-unreadable" };
  const missing = required.filter(id => !done.has(id));
  if (missing.length) return { ok: false, number, ready: false, missing, reason: "dependencies-missing" };
  await execute("gh", ["label", "create", TASK_STATE.ready, "--color", "287a61", "--force"], { cwd: root, timeoutMs: 20000, allowFailure: true });
  // 状态标签互斥：先读真实标签再算差集，不能只 --add-label。
  // 否则一个已经是 agent:waiting 的需求点「就绪」后会同时持有两个状态标签，
  // loop 与面板对它的判断就会打架。
  const held = new Set((view.labels ?? []).map(l => l.name ?? l));
  const editArgs = ["issue", "edit", String(number)];
  if (!held.has(TASK_STATE.ready)) editArgs.push("--add-label", TASK_STATE.ready);
  for (const name of STATE_LABELS) {
    if (name !== TASK_STATE.ready && held.has(name)) editArgs.push("--remove-label", name);
  }
  if (editArgs.length > 3) await execute("gh", editArgs, { cwd: root, timeoutMs: 30000 });
  return { ok: true, number, ready: true, missing: [], removed: [...held].filter(n => n !== TASK_STATE.ready && STATE_LABELS.includes(n)) };
}
