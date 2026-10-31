/**
 * Dashboard 服务器的通用工具：令牌校验、Host 允许清单、外部锁探测、日志脱敏。
 *
 * 从 dashboard.mjs 拆出（2026-11-02）：那个文件同时装着工具函数、协调器类与 HTTP 路由，
 * 837 行里三块互不相干的职责。这里只放与「服务器怎么保护自己」有关的部分。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { readdir, readFile, rm } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { join } from "node:path";

export function dashboardToken() { return randomBytes(24).toString("hex"); }

/** A supplied token may be any printable string; the generated default stays 48 hex chars. */
export function isValidToken(value) {
  return typeof value === "string" && /^[\x21-\x7e]{8,128}$/.test(value);
}

export function tokenMatches(header, expected) {
  if (typeof header !== "string" || !isValidToken(header)) return false;
  // Hash both sides so a shorter fixed token still compares in constant time.
  const a = createHash("sha256").update(header, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopbackHost(host) {
  return typeof host === "string" && (LOOPBACK_HOSTS.has(host) || host === "::ffff:127.0.0.1");
}

/**
 * Hosts/origins this process answers to. The list is an allowlist so an attacker
 * domain that resolves to this machine (DNS rebinding) is still rejected.
 */
export function allowedHosts(bindHost, port, interfaces = networkInterfaces()) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (isLoopbackHost(bindHost)) return hosts;
  if (bindHost !== "0.0.0.0" && bindHost !== "::") hosts.add(`${bindHost}:${port}`);
  for (const list of Object.values(interfaces ?? {})) {
    for (const nic of list ?? []) {
      if (nic.internal) continue;
      if (nic.family === "IPv4") hosts.add(`${nic.address}:${port}`);
      else if (nic.family === "IPv6") hosts.add(`[${nic.address}]:${port}`);
    }
  }
  return hosts;
}

/** 日志脱敏：ANSI 转义、凭据值、控制字符，并截断到 400 字符。 */
export function cleanLine(value) {
  return String(value).replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/(Bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|password|authorization|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").slice(0, 400);
}

/**
 * 外部锁明细。锁文件由旧版任务脚本写入，任务崩溃后会残留：进程已不存在的锁
 * 记为 stale，不再计入 busy —— 否则界面会长期显示"外部任务运行中"并禁用启动。
 */
export async function inspectExternalLocks(root) {
  const dir = join(root, ".soxu", "locks");
  let files;
  try { files = await readdir(dir); }
  catch (e) { if (e.code === "ENOENT") return { active: 0, stale: 0, locks: [] }; throw e; }
  const locks = [];
  for (const file of files.filter(x => /^(?:github|local)-issue-\d+\.lock$/.test(x))) {
    const path = join(dir, file);
    let pid = null, startedAt = null, readable = true;
    try {
      const lock = JSON.parse(await readFile(path, "utf8"));
      pid = Number.isSafeInteger(lock.pid) && lock.pid > 0 ? lock.pid : null;
      startedAt = typeof lock.startedAt === "string" ? lock.startedAt : null;
    } catch (e) { if (e.code !== "ENOENT") readable = false; }
    let alive = false;
    if (readable && pid) {
      try { process.kill(pid, 0); alive = true; }
      catch (e) { alive = e.code !== "ESRCH"; }
    }
    let updatedAt = null;
    try { updatedAt = (await stat(path)).mtime.toISOString(); } catch { /* vanished */ }
    // 进程已确认不存在（ESRCH）的锁是残留：任务被强杀时 finally 不会执行。
    // 直接清掉，避免界面长期显示"检测到 N 个正在运行的工作树锁"。
    // 只有明确 ESRCH 才删，读文件失败/权限错误一律保守保留。
    if (readable && pid && !alive) {
      try { await rm(path, { force: true }); } catch { /* 保留，下次再试 */ }
      locks.push({ file, pid, startedAt, updatedAt, stale: true, removed: true });
      continue;
    }
    locks.push({ file, pid, startedAt, updatedAt, stale: !alive });
  }
  return {
    active: locks.filter(l => !l.stale).length,
    stale: locks.filter(l => l.stale).length,
    locks,
  };
}
