import { readdir, readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { dataRoot } from "./config.mjs";

const ORDER_FILE = "queue-order.json";

// 与 github.mjs 的 STATE_LABELS 必须保持一致：同一时刻只允许存在一个状态标签。
// 不直接 import 是为了避开 github.mjs ↔ queue-order.mjs 的循环依赖
// （github.mjs 需要 readQueueOrder，本模块又需要标签清单）。
const STATE_LABELS = ["agent:ready", "agent:waiting", "agent:in-progress", "agent:paused", "agent:blocked", "agent:pr"];

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
export async function doneTaskIds(root) {
  try {
    const names = await readdir(join(root, "tasks", "done"));
    return new Set(names.flatMap(n => n.match(/TASK-\d{3,}/g) ?? []));
  } catch { return null; }
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
    await execute("gh", ["issue", "edit", String(number), "--remove-label", "agent:ready"], { cwd: root, timeoutMs: 30000, allowFailure: true });
    return { ok: true, number, ready: false, missing: [] };
  }
  const view = JSON.parse((await execute("gh", ["issue", "view", String(number), "--json", "number,title,body,labels,state"], { cwd: root, timeoutMs: 30000 })).stdout);
  if (view.state !== "OPEN") return { ok: false, number, ready: false, missing: [], reason: "issue-closed" };
  const { dependencyIds } = await import("./dashboard-intake.mjs");
  const required = dependencyIds(String(view.title ?? "") + "\n" + String(view.body ?? ""));
  const done = await doneTaskIds(root);
  if (!done) return { ok: false, number, ready: false, missing: required, reason: "tasks-done-unreadable" };
  const missing = required.filter(id => !done.has(id));
  if (missing.length) return { ok: false, number, ready: false, missing, reason: "dependencies-missing" };
  await execute("gh", ["label", "create", "agent:ready", "--color", "287a61", "--force"], { cwd: root, timeoutMs: 20000, allowFailure: true });
  // 状态标签互斥：先读真实标签再算差集，不能只 --add-label。
  // 否则一个已经是 agent:waiting 的需求点「就绪」后会同时持有两个状态标签，
  // loop 与面板对它的判断就会打架。
  const held = new Set((view.labels ?? []).map(l => l.name ?? l));
  const editArgs = ["issue", "edit", String(number)];
  if (!held.has("agent:ready")) editArgs.push("--add-label", "agent:ready");
  for (const name of STATE_LABELS) {
    if (name !== "agent:ready" && held.has(name)) editArgs.push("--remove-label", name);
  }
  if (editArgs.length > 3) await execute("gh", editArgs, { cwd: root, timeoutMs: 30000 });
  return { ok: true, number, ready: true, missing: [], removed: [...held].filter(n => n !== "agent:ready" && STATE_LABELS.includes(n)) };
}
