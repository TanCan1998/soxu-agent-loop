import { run } from "./process.mjs";
import { join } from "node:path";
import { TOOL_ROOT } from "./config.mjs";
import { PROTOCOL_VERSION, toolVersion } from "./runner-state.mjs";

const git = async (toolRoot, ...args) => (await run("git", args, { cwd: toolRoot, timeoutMs: 60_000 })).stdout.trim();

/** Default smoke gate: prove the new checkout still loads and its core tests pass. */
async function defaultSmoke({ toolRoot }) {
  await run(process.execPath, ["--test", join("automation", "loop", "tests", "status.test.mjs")], { cwd: toolRoot, timeoutMs: 120_000 });
}

function fail(message, status, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

/**
 * Read-only comparison between the installed tool checkout and its upstream.
 * Never mutates the working tree.
 */
export async function checkUpdate({ toolRoot = TOOL_ROOT } = {}) {
  const base = { toolRoot, protocolVersion: PROTOCOL_VERSION, checkedAt: new Date().toISOString() };
  let branch, current;
  try {
    branch = await git(toolRoot, "rev-parse", "--abbrev-ref", "HEAD");
    current = await git(toolRoot, "rev-parse", "HEAD");
  } catch {
    return { ...base, status: "not-a-repo", available: false, dirty: null, branch: null, current: null, upstream: null, ahead: null, behind: null };
  }
  const dirty = (await git(toolRoot, "status", "--porcelain=v1")).length > 0;
  let upstream = null;
  try { upstream = await git(toolRoot, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"); }
  catch { upstream = null; }
  const result = { ...base, branch, current, upstream, dirty, ahead: null, behind: null, available: false, error: null, toolVersion: toolVersion(toolRoot) };
  if (!upstream) return { ...result, status: "no-upstream" };
  try {
    await git(toolRoot, "fetch", "--quiet", "origin");
    const [ahead, behind] = (await git(toolRoot, "rev-list", "--left-right", "--count", `HEAD...${upstream}`))
      .split(/\s+/).map(Number);
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
export async function applyUpdate({ toolRoot = TOOL_ROOT, smoke = defaultSmoke } = {}) {
  const before = await checkUpdate({ toolRoot });
  if (before.status === "not-a-repo") throw fail("tool-not-a-git-checkout", 409, { details: before });
  if (before.dirty) throw fail("tool-repo-dirty", 409, { details: before });
  if (before.status === "no-upstream") throw fail("tool-upstream-missing", 409, { details: before });
  if (before.status === "unreachable") throw fail("tool-upstream-unreachable", 409, { details: before });
  if (!before.available) return { status: "up-to-date", previous: before.current, current: before.current, details: before };
  const previous = before.current;
  try {
    await git(toolRoot, "merge", "--ff-only", before.upstream);
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
    note: "Running tasks keep the code they started with; restart the dashboard (and start new runs) to use the update.",
  };
}
