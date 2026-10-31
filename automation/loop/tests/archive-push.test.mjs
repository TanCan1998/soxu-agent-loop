/**
 * 归档提交的推送策略：只在能快进时自动推，分叉一律保留。
 *
 * 背景（2026-10-31）：cleanup 归档任务文件时会在目标仓库的集成分支上提交，但从不推送。
 * 于是本地 dev 领先 origin，几天后与远端分叉（当时是 2/2），下一次 worktree 基点、
 * 依赖检查与实际远端状态就对不上。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/process.mjs";
import { pushArchiveCommits } from "../src/merged-cleanup.mjs";

async function fixture(fn) {
  const tmp = await mkdtemp(join(tmpdir(), "soxu-archive-push-"));
  const remote = join(tmp, "remote.git");
  const seed = join(tmp, "seed");
  const work = join(tmp, "work");
  const git = async (args, cwd) => run("git", args, { cwd });
  try {
    await git(["init", "--bare", remote], tmp);
    await mkdir(seed, { recursive: true });
    await git(["init", "-b", "dev"], seed);
    await git(["config", "user.email", "t@example.com"], seed);
    await git(["config", "user.name", "T"], seed);
    await writeFile(join(seed, "README.md"), "base\n");
    await git(["add", "."], seed);
    await git(["commit", "-m", "init"], seed);
    await git(["remote", "add", "origin", remote], seed);
    await git(["push", "-u", "origin", "dev"], seed);
    await git(["clone", remote, work], tmp);
    await git(["config", "user.email", "t@example.com"], work);
    await git(["config", "user.name", "T"], work);
    await git(["checkout", "dev"], work);
    await fn({ tmp, remote, seed, work, git, exec: (bin, args, opts) => run(bin, args, opts) });
  } finally {
    await rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  }
}

async function commitFile(x, name, body) {
  await writeFile(join(x.work, name), body);
  await x.git(["add", name], x.work);
  await x.git(["commit", "-m", "🔧 chore(tasks): 归档 " + name], x.work);
}

test("本地领先且不落后：归档提交自动推送到集成分支", () => fixture(async (x) => {
  await commitFile(x, "TASK-901.md", "a");
  const result = await pushArchiveCommits(x.exec, x.work, "dev", () => {});
  assert.equal(result.pushed, true, JSON.stringify(result));
  assert.equal(result.ahead, 1);
  const remoteHead = (await x.git(["rev-parse", "dev"], x.remote)).stdout.trim();
  const localHead = (await x.git(["rev-parse", "dev"], x.work)).stdout.trim();
  assert.equal(remoteHead, localHead, "远端必须指向本地 HEAD");
}));

test("没有本地提交时不推送", () => fixture(async (x) => {
  const result = await pushArchiveCommits(x.exec, x.work, "dev", () => {});
  assert.equal(result.pushed, false);
  assert.equal(result.reason, "nothing-to-push");
}));

test("分叉（既领先又落后）绝不 force push，保留现场", () => fixture(async (x) => {
  await commitFile(x, "TASK-902.md", "local");
  // 远端在另一个克隆上前进一步，制造分叉。
  await writeFile(join(x.seed, "remote-only.md"), "remote\n");
  await x.git(["add", "remote-only.md"], x.seed);
  await x.git(["commit", "-m", "🔧 chore: remote advance"], x.seed);
  await x.git(["push", "origin", "dev"], x.seed);
  const remoteBefore = (await x.git(["rev-parse", "dev"], x.remote)).stdout.trim();
  const result = await pushArchiveCommits(x.exec, x.work, "dev", () => {});
  assert.equal(result.pushed, false);
  assert.equal(result.reason, "diverged");
  assert.equal(result.ahead, 1);
  assert.equal(result.behind, 1);
  const remoteAfter = (await x.git(["rev-parse", "dev"], x.remote)).stdout.trim();
  assert.equal(remoteAfter, remoteBefore, "分叉时远端不能被改写");
}));

test("当前不在集成分支时不推送", () => fixture(async (x) => {
  await x.git(["checkout", "-b", "agent/github-issue-1-x"], x.work);
  await commitFile(x, "TASK-903.md", "b");
  const result = await pushArchiveCommits(x.exec, x.work, "dev", () => {});
  assert.equal(result.pushed, false);
  assert.equal(result.reason, "not-on-base");
  assert.equal(result.head, "agent/github-issue-1-x");
}));
