import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataRoot, ROOT, TOOL_ROOT } from "./config.mjs";

/**
 * Bump this whenever the dashboard/runner contract changes. A mismatch must never
 * be silently adopted: the dashboard would then show a runner it cannot control.
 */
export const PROTOCOL_VERSION = 1;
const SCHEMA_VERSION = 1;

export function runnerDir(root = ROOT) { return join(dataRoot(root), "runner"); }
export function runnerStatePath(root = ROOT) { return join(runnerDir(root), "state.json"); }
export function runnerExitPath(root = ROOT) { return join(runnerDir(root), "last-exit.json"); }
export function runnerLogPath(root = ROOT, pid) { return join(runnerDir(root), `runner-${pid}.log`); }

/** Tool version is informational only; protocolVersion decides compatibility. */
export function toolVersion(toolRoot = TOOL_ROOT) {
  try { return JSON.parse(readFileSync(join(toolRoot, "package.json"), "utf8")).version ?? "unknown"; }
  catch { return "unknown"; }
}

export function validPid(pid) { return Number.isSafeInteger(pid) && pid > 0 && pid < 1e9; }

/** Signal 0 probes existence; EPERM means the process exists but belongs to another user. */
export function pidAlive(pid) {
  if (!validPid(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return null; return { invalid: true, error: e.message }; }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(tmp, path);
  } finally { await rm(tmp, { force: true }); }
}

export async function writeRunnerState(state, root = ROOT) {
  if (!validPid(state?.pid)) throw new Error("Invalid runner pid");
  if (typeof state.command !== "string" || !state.command) throw new Error("Invalid runner command");
  const record = {
    schemaVersion: SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    toolVersion: toolVersion(),
    command: state.command,
    pid: state.pid,
    startedAt: state.startedAt ?? new Date().toISOString(),
    logPath: state.logPath ?? runnerLogPath(root, state.pid),
  };
  await writeJson(runnerStatePath(root), record);
  return record;
}

export async function readRunnerState(root = ROOT) {
  const state = await readJson(runnerStatePath(root));
  if (!state || state.invalid) return state;
  if (state.schemaVersion !== SCHEMA_VERSION) return { invalid: true, error: "unsupported runner state schema" };
  if (!validPid(state.pid) || typeof state.command !== "string") return { invalid: true, error: "corrupt runner state" };
  return state;
}

/** Only clear the record for the same pid, so a newer runner is never erased. */
export async function clearRunnerState(pid, root = ROOT) {
  const state = await readRunnerState(root);
  if (!state || state.invalid || state.pid !== pid) return false;
  await rm(runnerStatePath(root), { force: true });
  return true;
}

export async function recordRunnerExit(exit, root = ROOT) {
  const record = {
    schemaVersion: SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    command: String(exit?.command ?? "unknown"),
    pid: validPid(exit?.pid) ? exit.pid : null,
    exitCode: Number.isInteger(exit?.exitCode) ? exit.exitCode : null,
    signal: typeof exit?.signal === "string" ? exit.signal : null,
    finishedAt: new Date().toISOString(),
    reason: typeof exit?.reason === "string" ? exit.reason : null,
  };
  await writeJson(runnerExitPath(root), record);
  return record;
}

export async function readRunnerExit(root = ROOT) {
  const exit = await readJson(runnerExitPath(root));
  return exit && !exit.invalid ? exit : null;
}

/**
 * Exit handlers must be synchronous: an async write never completes during
 * process teardown. Records the exit, then clears the state for this pid only.
 */
export function recordRunnerExitSync(exit, root = ROOT) {
  const record = {
    schemaVersion: SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    command: String(exit?.command ?? "unknown"),
    pid: validPid(exit?.pid) ? exit.pid : null,
    exitCode: Number.isInteger(exit?.exitCode) ? exit.exitCode : null,
    signal: typeof exit?.signal === "string" ? exit.signal : null,
    finishedAt: new Date().toISOString(),
    reason: typeof exit?.reason === "string" ? exit.reason : null,
  };
  mkdirSync(runnerDir(root), { recursive: true });
  writeFileSync(runnerExitPath(root), JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  try {
    const current = JSON.parse(readFileSync(runnerStatePath(root), "utf8"));
    if (current?.pid === record.pid) rmSync(runnerStatePath(root), { force: true });
  } catch { /* Missing or foreign state must not fail teardown. */ }
  return record;
}

/** An unknown or mismatched protocol is reported, never guessed. */
export function runnerCompatible(state) {
  return Boolean(state) && !state.invalid && state.protocolVersion === PROTOCOL_VERSION;
}

export async function runnerStatus(root = ROOT) {
  const state = await readRunnerState(root);
  if (!state) return { state: "none", protocolVersion: PROTOCOL_VERSION, toolVersion: toolVersion() };
  if (state.invalid) return { state: "corrupt", error: state.error, protocolVersion: PROTOCOL_VERSION, toolVersion: toolVersion() };
  const compatible = runnerCompatible(state);
  const alive = pidAlive(state.pid);
  return {
    state: !alive ? "finished" : compatible ? "running" : "incompatible",
    compatible,
    pid: state.pid,
    command: state.command,
    startedAt: state.startedAt,
    logPath: state.logPath,
    protocolVersion: state.protocolVersion,
    toolVersion: state.toolVersion,
  };
}
