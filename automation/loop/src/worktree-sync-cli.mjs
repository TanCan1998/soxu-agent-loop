#!/usr/bin/env node
import { inspectWorktrees } from "./worktree-sync.mjs";

const args = process.argv.slice(2).filter(x => x !== "--");
if (args.some(x => x !== "--sync" && x !== "--json"))
  throw new Error("Usage: pnpm agent:worktrees [-- --sync] [-- --json]");
const sync = args.includes("--sync");
const result = await inspectWorktrees({ sync });
if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
else {
  console.log(sync ? "SOXU worktrees vs refreshed origin/main" : "SOXU worktrees vs local origin/main (use git fetch origin main first)");
  for (const item of result) {
    console.log("#" + item.issue + " " + item.status + "/" + item.phase +
      " behind=" + (item.behind ?? "?") + " ahead=" + (item.ahead ?? "?") +
      " dirty=" + (item.dirty ?? "?") + " lock=" + item.lock +
      " [" + (item.reason ?? "can-sync") + "]");
    console.log("  " + (item.directory ?? "(no path)"));
  }
  if (!result.length) console.log("No recorded task worktrees.");
  if (result.some(item => item.reason === "synced-conflicts"))
    console.log("Conflicts preserved with a stash backup. Run pnpm agent:resume to have Pi Developer resolve them.");
}
if (sync && result.some(x => x.reason?.startsWith("sync-failed") || x.reason === "changed-during-sync"))
  process.exitCode = 1;
