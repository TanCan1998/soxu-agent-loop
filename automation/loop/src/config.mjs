import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve, join } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
export const TOOL_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const projectRoot = process.env.SOXU_PROJECT_ROOT;
if (projectRoot !== undefined && (!projectRoot || !isAbsolute(projectRoot))) {
  throw new Error("SOXU_PROJECT_ROOT must be a non-empty absolute path");
}
if (!projectRoot) throw new Error("SOXU_PROJECT_ROOT is required for the standalone agent loop");
export const ROOT = resolve(projectRoot);
const dataDir = process.env.SOXU_DATA_DIR;
if (dataDir !== undefined && (!dataDir || !isAbsolute(dataDir))) throw new Error("SOXU_DATA_DIR must be a non-empty absolute path");
export function dataRoot(root = ROOT) {
  if (!dataDir || resolve(root) !== ROOT || resolve(dataDir) === resolve(ROOT, ".soxu")) return join(root, ".soxu");
  const directory = resolve(dataDir);
  let binding;
  try { binding = JSON.parse(readFileSync(join(directory, ".soxu-project.json"), "utf8")); }
  catch { throw new Error("External data directory is not initialized; run the migration command first"); }
  const actual = realpathSync(ROOT);
  const matches = typeof binding.project === "string" && (process.platform === "win32" ? binding.project.toLowerCase() === actual.toLowerCase() : binding.project === actual);
  if (binding.version !== 1 || !matches) throw new Error("External data directory belongs to a different project");
  return directory;
}
export async function policy() {
  const value = JSON.parse(await readFile(resolve(ROOT, "automation/policy.json"), "utf8"));
  for (const name of ["maxConcurrentAgents", "maxRoundsPerInvocation", "maxRetries", "maxChangedFiles", "maxChangedBytes"]) {
    if (!Number.isSafeInteger(value[name]) || value[name] < 0) throw new Error(`Invalid policy: ${name}`);
  }
  if (value.maxConcurrentAgents < 1 || value.maxConcurrentAgents > 4) throw new Error("maxConcurrentAgents must be 1..4");
  if (value.maxRoundsPerInvocation > 50 || value.maxRetries > 3) throw new Error("policy exceeds safety limits");
  if (value.watchIntervalMinutes < 5 || value.maxContinuousHours > 24 || value.maxIssuesPerWatch > 50) throw new Error("Watch budget is outside safe bounds");
  const t = value.timeouts ?? {};
  for (const [name, min, max] of [["piStartupSeconds", 10, 300], ["piIdleSeconds", 30, 900], ["piHardMinutes", 5, 90], ["reviewHardMinutes", 2, 30], ["installMinutes", 1, 20], ["networkSeconds", 10, 120], ["shutdownGraceSeconds", 1, 10]]) {
    if (!Number.isSafeInteger(t[name]) || t[name] < min || t[name] > max) throw new Error(`Invalid timeouts.${name} (expected ${min}..${max})`);
  }
  if (t.piHardMinutes * 60 <= t.piStartupSeconds || t.piHardMinutes * 60 <= t.piIdleSeconds) throw new Error("Hard timeout must exceed startup/idle timeout");
  if (value.recovery?.automaticApiRetries !== 0 || !value.recovery?.preserveWorktree || !value.recovery?.manualOnQuota || !value.recovery?.manualOnNetwork) throw new Error("Bootstrap recovery policy requires no automatic API retries and preserved worktrees");
  if (value.releaseChannel !== "prerelease") throw new Error("Only prerelease is permitted in bootstrap");
  return value;
}
