/**
 * 残留进程登记表：解决「Agent 把长驻服务后台化后 runner 收不到」的问题。
 *
 * 背景：rpc.mjs 用 `taskkill /PID <pi> /T /F` 收拾 Pi 的进程树，但 `/T` 只沿着 PPID
 * 链走。Agent 一旦用 `start /b`、`Start-Process`、`cmd /c start` 之类把 `tauri dev`
 * 后台化，进程就脱离 Pi 的树，任何基于进程树的清理都够不到它。
 *
 * 因此改成「谁起的谁登记」：Agent（或未来的 worker wrapper）把 pid 写进本任务专属的
 * 登记文件，任务收尾时只回收**登记过且指纹匹配**的 pid。这样并行的其他 runner、
 * 用户自己开的 dev server 都不会被误伤。
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dataRoot, ROOT } from "./config.mjs";
import { run } from "./process.mjs";

const SCHEMA_VERSION = 1;
/** 启动时间允许的偏差：进程创建与登记之间通常只差几十毫秒。 */
const STARTED_AT_TOLERANCE_MS = 2_000;

/** 任务键：与工作目录命名保持一致，便于人工核对。 */
export function taskKey(issue, local = false) {
  return `${local ? "local" : "github"}-issue-${issue.number}`;
}

export function registryFile(root, key) {
  return join(dataRoot(root), "run", "pids", `${key}.json`);
}

export async function readEntries(root, key) {
  try {
    const raw = await readFile(registryFile(root, key), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

async function writeEntries(root, key, entries) {
  const file = registryFile(root, key);
  if (!entries.length) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ schemaVersion: SCHEMA_VERSION, key, entries }, null, 2) + "\n", "utf8");
}

/** 命令行指纹：压掉空白、截断、统一小写，只用于「是不是同一个进程」的粗判。 */
export function fingerprint(command) {
  return String(command ?? "").replace(/\s+/g, " ").trim().slice(0, 200).toLowerCase();
}

/** 登记一个需要回收的 pid；同一 pid 重复登记时更新最后一条。 */
export async function registerProcess({ root = ROOT, key, pid, command = "", startedAtMs = null, execute = run } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("pid must be a positive integer");
  if (!key) throw new Error("key is required");
  const live = await inspectProcess(pid, { execute });
  const entries = await readEntries(root, key);
  const entry = {
    pid,
    command: live?.command || command,
    startedAtMs: Number.isFinite(live?.startedAtMs) ? live.startedAtMs : startedAtMs,
    registeredAtMs: Date.now(),
  };
  const next = [...entries.filter(item => item.pid !== pid), entry];
  await writeEntries(root, key, next);
  return entry;
}

/**
 * 回收本任务登记的残留进程。
 *
 * - 进程已退出：删掉登记项；
 * - pid 仍存活但指纹不匹配（pid 被系统复用）：跳过并保留记录，交人工核对；
 * - 指纹匹配：杀掉。
 *
 * 只读本 key 的登记文件，因此永远不会碰到并行 runner 或用户自己的进程。
 */
export async function sweepProcesses({ root = ROOT, key, execute = run, kill } = {}) {
  const entries = await readEntries(root, key);
  const killed = [], skipped = [];
  let pruned = 0;
  const kept = [];
  for (const entry of entries) {
    const live = await inspectProcess(entry.pid, { execute });
    if (!live) { pruned += 1; continue; }
    if (!sameProcess(entry, live)) {
      skipped.push({ pid: entry.pid, reason: "pid-reused", command: live.command });
      kept.push(entry);
      continue;
    }
    try {
      await (kill ?? defaultKill)(entry.pid, { execute });
      killed.push(entry.pid);
    } catch (error) {
      skipped.push({ pid: entry.pid, reason: "kill-failed", detail: String(error?.message ?? error).slice(0, 160) });
      kept.push(entry);
    }
  }
  await writeEntries(root, key, kept);
  return { killed, skipped, pruned };
}

/** 判断登记项与当前进程是否同一实体：启动时间优先，缺失时退化为命令指纹。 */
export function sameProcess(entry, live) {
  if (!live) return false;
  if (Number.isFinite(entry?.startedAtMs) && Number.isFinite(live.startedAtMs)) {
    return Math.abs(live.startedAtMs - entry.startedAtMs) <= STARTED_AT_TOLERANCE_MS;
  }
  const expected = fingerprint(entry?.command);
  const actual = fingerprint(live.command);
  if (!expected || !actual) return false;
  return expected === actual || expected.includes(actual) || actual.includes(expected);
}

/** 查询单个 pid 的当前状态；不存在或查询失败一律返回 null（不猜测）。 */
export async function inspectProcess(pid, { execute = run, platform = process.platform } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (platform === "win32") {
      const script = `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress`;
      const { stdout } = await execute("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], { cwd: ROOT, timeoutMs: 20_000, allowFailure: true });
      const text = String(stdout ?? "").trim();
      if (!text || text === "null") return null;
      const parsed = JSON.parse(text);
      if (Number(parsed?.ProcessId) !== pid) return null;
      const created = parsed?.CreationDate;
      const startedAtMs = typeof created === "string" ? Date.parse(created) : (created?.value ?? null);
      return { pid, command: String(parsed?.CommandLine ?? ""), startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null };
    }
    const { stdout, code } = await execute("ps", ["-o", "pid=,lstart=,args=", "-p", String(pid)], { cwd: ROOT, timeoutMs: 20_000, allowFailure: true });
    const text = String(stdout ?? "").trim();
    if (!text) return null;
    const match = /^(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(text);
    if (!match) return null;
    const startedAtMs = Date.parse(match[2]);
    return { pid: Number(match[1]), command: match[3], startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null };
  } catch {
    return null;
  }
}

async function defaultKill(pid, { execute = run } = {}) {
  if (process.platform === "win32") {
    // /T 一起带走仍挂在它下面的子进程；已经 detach 的后代靠各自的登记项处理。
    await execute("taskkill", ["/PID", String(pid), "/T", "/F"], { cwd: ROOT, timeoutMs: 15_000, allowFailure: true });
    return;
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* 已经退出 */ }
}