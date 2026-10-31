/**
 * 守卫测试：行尾空白自动清理（2026-10-31 TASK-037 连续因此暂停）。
 *
 * `git diff --cached --check` 对行尾空格报错，而 Agent 写多行调用时很容易带出尾随空格。
 * 这是完全可确定修复的机械问题，不该花一次模型调用、更不该把任务判成失败。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/process.mjs";
import { inspectChanges, stripTrailingWhitespace } from "../src/guards.mjs";

const POLICY = { maxChangedFiles: 80, maxChangedBytes: 1_500_000, protectedPaths: [] };

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "soxu-ws-fix-"));
  const git = async (args) => run("git", args, { cwd: root });
  try {
    await git(["init", "-b", "main"]);
    await git(["config", "user.email", "t@example.com"]);
    await git(["config", "user.name", "T"]);
    await writeFile(join(root, "README.md"), "base\n");
    await git(["add", "."]);
    await git(["commit", "-m", "🔧 chore: init"]);
    const base = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await fn({ root, git, base });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
}

test("只清理代码文件，Markdown 的硬换行保持不动", async () => {
  const root = await mkdtemp(join(tmpdir(), "soxu-ws-unit-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.mjs"), "const a = 1;   \nconst b = 2;\t\n");
    await writeFile(join(root, "doc.md"), "第一行  \n第二行\n");
    const fixed = await stripTrailingWhitespace(root, ["src/a.mjs", "doc.md", "missing.mjs", "img.png"]);
    assert.deepEqual(fixed, ["src/a.mjs"]);
    assert.equal(await readFile(join(root, "src", "a.mjs"), "utf8"), "const a = 1;\nconst b = 2;\n");
    assert.equal(await readFile(join(root, "doc.md"), "utf8"), "第一行  \n第二行\n", "Markdown 尾随空格的硬换行不能删");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("inspectChanges：代码文件带行尾空格时自动修复并通过检查", () => fixture(async ({ root, base }) => {
  await mkdir(join(root, "apps"), { recursive: true });
  await writeFile(join(root, "apps", "page.ts"), "export const x = 1;   \nexport const y = 2;\t\n");
  const paths = await inspectChanges(root, base, POLICY);
  assert.ok(paths.includes("apps/page.ts"));
  assert.equal(await readFile(join(root, "apps", "page.ts"), "utf8"), "export const x = 1;\nexport const y = 2;\n");
  // 修复后必须在暂存区里，且不带空白问题
  const check = await run("git", ["diff", "--cached", "--check"], { cwd: root, allowFailure: true });
  assert.equal(check.code, 0, "自动修复后不应再有空白错误");
  const staged = (await run("git", ["diff", "--cached", "--name-only"], { cwd: root })).stdout;
  assert.match(staged, /apps\/page\.ts/);
}));

test("inspectChanges：Markdown 的行尾空格仍然判失败（不掩盖真问题）", () => fixture(async ({ root, base }) => {
  await writeFile(join(root, "notes.md"), "行一  \n行二  \n");
  await assert.rejects(() => inspectChanges(root, base, POLICY), /trailing whitespace|whitespace/i);
}));
