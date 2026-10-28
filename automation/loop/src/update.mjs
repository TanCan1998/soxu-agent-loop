import { run } from "./process.mjs";
import { join } from "node:path";
import { TOOL_ROOT } from "./config.mjs";
import { PROTOCOL_VERSION, toolVersion } from "./runner-state.mjs";

/** The dashboard always compares (and updates) this branch, whatever is checked out. */
export const UPDATE_BRANCH = "main";

const git = async (toolRoot, ...args) => (await run("git", args, { cwd: toolRoot, timeoutMs: 60_000 })).stdout.trim();

/** Default smoke gate: prove the new checkout still loads and its core tests pass. */
async function defaultSmoke({ toolRoot }) {
  await run(process.execPath, ["--test", join("automation", "loop", "tests", "status.test.mjs")], { cwd: toolRoot, timeoutMs: 120_000 });
}

function fail(message, status, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

/**
 * Read-only comparison of refs/heads/<branch> against refs/remotes/origin/<branch>.
 * Using explicit refs (not HEAD upstream) means a feature-branch checkout cannot make
 * the answer "no update" — the comparison is always main → origin/main.
 */
export async function checkUpdate({ toolRoot = TOOL_ROOT, branch = UPDATE_BRANCH } = {}) {
  const base = {
    toolRoot, branch, comparison: branch + " → origin/" + branch,
    protocolVersion: PROTOCOL_VERSION, checkedAt: new Date().toISOString(),
  };
  let current;
  try { current = await git(toolRoot, "rev-parse", "refs/heads/" + branch); }
  catch { return { ...base, status: "missing-branch", available: false, dirty: null, head: null, current: null, ahead: null, behind: null }; }
  let dirty = null, head = null;
  try {
    dirty = (await git(toolRoot, "status", "--porcelain=v1")).length > 0;
    head = await git(toolRoot, "rev-parse", "--abbrev-ref", "HEAD");
  } catch { /* Reported through status below. */ }
  const result = { ...base, current, head, dirty, ahead: null, behind: null, available: false, error: null, toolVersion: toolVersion(toolRoot) };
  try {
    await git(toolRoot, "fetch", "--quiet", "origin");
    const [ahead, behind] = (await git(toolRoot, "rev-list", "--left-right", "--count",
      "refs/heads/" + branch + "...refs/remotes/origin/" + branch)).split(/\s+/).map(Number);
    return { ...result, status: "ok", ahead, behind, available: behind > 0 };
  } catch (e) {
    return { ...result, status: "unreachable", error: String(e?.message ?? e).slice(0, 300) };
  }
}

/**
 * Fast-forward the tool checkout and keep running tasks untouched: Node has already
 * loaded the old modules into the live process, so only future processes use the new code.
 * Any failure after the merge is rolled back to the recorded commit.
 */
export async function applyUpdate({ toolRoot = TOOL_ROOT, smoke = defaultSmoke, branch = UPDATE_BRANCH } = {}) {
  const before = await checkUpdate({ toolRoot, branch });
  if (before.status === "missing-branch") throw fail("tool-branch-missing", 409, { details: before });
  if (before.dirty) throw fail("tool-repo-dirty", 409, { details: before });
  if (before.status === "unreachable") throw fail("tool-upstream-unreachable", 409, { details: before });
  // Fast-forwarding a non-checked-out branch would leave the served files stale.
  if (before.head !== branch) throw fail("tool-not-on-main", 409, { details: before });
  if (!before.available) return { status: "up-to-date", previous: before.current, current: before.current, details: before };
  const previous = before.current;
  try {
    await git(toolRoot, "merge", "--ff-only", "refs/remotes/origin/" + branch);
  } catch (e) {
    // --ff-only never leaves a half-merged tree; report without touching the checkout.
    return { status: "not-fast-forward", previous, current: before.current, error: String(e?.message ?? e).slice(0, 300), details: before };
  }
  try {
    await smoke({ toolRoot });
  } catch (e) {
    try { await git(toolRoot, "reset", "--hard", previous); }
    catch { /* Reported below: the operator must restore manually. */ }
    return {
      status: "rolled-back",
      previous,
      current: await git(toolRoot, "rev-parse", "HEAD").catch(() => null),
      error: String(e?.message ?? e).slice(0, 300),
      restartRequired: false,
      note: "Smoke check failed after fast-forward; checkout reset to the previous commit.",
    };
  }
  return {
    status: "updated",
    previous,
    current: await git(toolRoot, "rev-parse", "HEAD"),
    toolVersion: toolVersion(toolRoot),
    restartRequired: true,
    note: "Running tasks keep the code they started with; the dashboard restarts itself to load the update.",
  };
}
