import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve, join } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
export const TOOL_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Resolve the target project. An explicit SOXU_PROJECT_ROOT always wins and must be an
 * absolute path; otherwise fall back to the sibling SOXU checkout so that
 * `pnpm agent:dashboard` works directly from the tool repository root.
 * Anything else fails closed: a wrong target silently would touch the wrong repo.
 */
export function pickProjectRoot({ value, toolRoot = TOOL_ROOT, exists = existsSync } = {}) {
  if (value !== undefined) {
    if (!value || !isAbsolute(value)) throw new Error("SOXU_PROJECT_ROOT must be a non-empty absolute path");
    return { root: resolve(value), source: "env" };
  }
  const sibling = resolve(toolRoot, "..", "SOXU");
  if (exists(join(sibling, ".git"))) return { root: sibling, source: "sibling" };
  throw new Error("SOXU_PROJECT_ROOT is required for the standalone agent loop (no sibling SOXU checkout found)");
}
const picked = pickProjectRoot({ value: process.env.SOXU_PROJECT_ROOT });
/** "env" when SOXU_PROJECT_ROOT was used, "sibling" for the adjacent SOXU checkout. */
export const PROJECT_ROOT_SOURCE = picked.source;
export const ROOT = picked.root;
const dataDir = process.env.SOXU_DATA_DIR;
if (dataDir !== undefined && (!dataDir || !isAbsolute(dataDir))) throw new Error("SOXU_DATA_DIR must be a non-empty absolute path");
export function dataRoot(root = ROOT) {
  if (!dataDir || resolve(root) !== ROOT || resolve(dataDir) === resolve(ROOT, ".soxu")) return join(root, ".soxu");
  const directory = resolve(dataDir);
  let binding;
  try { binding = JSON.parse(readFileSync(join(directory, ".soxu-project.json"), "utf8")); }
  catch { throw new Error("External data directory is not initialized; run the migration command first"); }
  const canonical = process.platform === "win32" ? realpathSync.native : realpathSync;
  const actual = canonical(ROOT);
  let recorded;
  try { recorded = typeof binding.project === "string" ? canonical(binding.project) : ""; } catch { recorded = ""; }
  const matches = process.platform === "win32" ? recorded.toLowerCase() === actual.toLowerCase() : recorded === actual;
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
  // main is release-only; agents integrate into a separate branch.
  const branchName = /^[A-Za-z0-9._/-]{1,80}$/;
  for (const name of ["integrationBranch", "releaseBranch"]) {
    if (value[name] !== undefined && (typeof value[name] !== "string" || !branchName.test(value[name]))) throw new Error(`Invalid policy: ${name}`);
  }
  // Only enforced when the project opts into a separate integration branch.
  if (value.integrationBranch !== undefined && value.integrationBranch === value.releaseBranch)
    throw new Error("integrationBranch must differ from releaseBranch");
  return value;
}
