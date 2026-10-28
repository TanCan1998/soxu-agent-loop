import { readdir, readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { dataRoot } from "./config.mjs";

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
  await execute("gh", ["issue", "edit", String(number), "--add-label", "agent:ready"], { cwd: root, timeoutMs: 30000 });
  return { ok: true, number, ready: true, missing: [] };
}
