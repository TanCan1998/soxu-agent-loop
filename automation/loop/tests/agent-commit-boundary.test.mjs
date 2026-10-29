import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ROOT } from "../src/config.mjs";

// 源码在 loop 仓库，策略文件在目标项目（ROOT）。两者必须分开取。
const readSrc = name => readFile(new URL(`../src/${name}`, import.meta.url), "utf8");

test("Agent 会话被标记，且不继承 Runner 的提权", async () => {
  const rpc = await readSrc("rpc.mjs");
  assert.match(rpc, /env\.SOXU_AGENT_SESSION = "1"/, "必须给 Pi 子进程标记 Agent 会话");
  assert.match(rpc, /delete env\.SOXU_ALLOW_COMMIT/, "绝不能让 Agent 继承提交提权");
});

test("Runner 自己提交时显式提权", async () => {
  const worker = await readSrc("worker.mjs");
  const idx = worker.indexOf('git(["commit"');
  assert.ok(idx > 0, "Runner 的提交调用必须存在");
  const window = worker.slice(idx, idx + 400);
  assert.match(window, /SOXU_ALLOW_COMMIT: "1"/, "Runner 提交必须带提权，否则会被自己的 hook 拦住");
});

test("策略文件按角色注入 Agent 上下文，而不是只列路径", async () => {
  const worker = await readSrc("worker.mjs");
  assert.match(worker, /ROLE_POLICIES/, "必须有按角色的策略映射");
  assert.match(worker, /async function loadRolePolicies/, "必须有策略加载函数");
  const devStart = worker.indexOf("developer: [");
  assert.ok(devStart > 0, "必须有 developer 的策略清单");
  const devEntry = worker.slice(devStart, worker.indexOf("],", devStart));
  assert.match(devEntry, /git-workflow/, "developer 必须注入 git-workflow（commit 边界写在那里）");
  assert.match(worker, /devPolicies/, "Developer prompt 必须拼接策略");
  assert.match(worker, /reviewPolicies/, "Reviewer prompt 必须拼接策略");
});

test("被注入的策略文件都真实存在且非空", async () => {
  const worker = await readSrc("worker.mjs");
  const start = worker.indexOf("const ROLE_POLICIES");
  const block = worker.slice(start, worker.indexOf("};", start));
  const names = [...new Set([...block.matchAll(/"([a-z][a-z-]+)"/g)].map(m => m[1]))];
  assert.ok(names.length >= 5, "至少覆盖 5 个策略文件，实际 " + names.length);
  for (const name of names) {
    const text = await readFile(join(ROOT, `agents/policies/${name}.md`), "utf8");
    assert.ok(text.trim().length > 0, `agents/policies/${name}.md 不能为空`);
  }
});

test("Pi 子进程实际收到 Agent 会话标记，且拿不到提权", { skip: process.platform === "win32" }, async () => {
  const { runPi } = await import("../src/rpc.mjs");
  const dir = await mkdtemp(join(tmpdir(), "soxu-env-probe-"));
  const file = join(dir, "fake-pi");
  const prevBin = process.env.SOXU_PI_BIN;
  const prevAllow = process.env.SOXU_ALLOW_COMMIT;
  const probe = [
    "#!/usr/bin/env node",
    'process.stderr.write("ENVPROBE:" + JSON.stringify({ session: process.env.SOXU_AGENT_SESSION ?? null, allow: process.env.SOXU_ALLOW_COMMIT ?? null }) + "\\n");',
    'let b = "";',
    'process.stdin.on("data", c => {',
    "  b += c;",
    '  for (const line of b.split("\\n").filter(Boolean)) {',
    "    const m = JSON.parse(line);",
    '    if (m.type === "prompt") {',
    '      process.stdout.write(JSON.stringify({ type: "response", id: m.id, success: true, data: { disposition: "handled" } }) + "\\n");',
    '      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");',
    "      break;",
    "    }",
    "  }",
    "});",
  ].join("\n");
  try {
    await writeFile(file, probe);
    await chmod(file, 0o755);
    process.env.SOXU_PI_BIN = file;
    // 父进程故意带提权标记，验证子进程拿不到。
    process.env.SOXU_ALLOW_COMMIT = "1";
    const result = await runPi({ cwd: dir, prompt: "probe", timeoutMs: 15000 });
    const line = result.stderr.split("\n").find(l => l.includes("ENVPROBE:"));
    assert.ok(line, "fake Pi 必须报告环境变量");
    const env = JSON.parse(line.slice(line.indexOf("ENVPROBE:") + 9));
    assert.equal(env.session, "1", "Agent 会话必须被标记");
    assert.equal(env.allow, null, "Agent 绝不能继承 SOXU_ALLOW_COMMIT");
  } finally {
    if (prevBin === undefined) delete process.env.SOXU_PI_BIN; else process.env.SOXU_PI_BIN = prevBin;
    if (prevAllow === undefined) delete process.env.SOXU_ALLOW_COMMIT; else process.env.SOXU_ALLOW_COMMIT = prevAllow;
    await rm(dir, { recursive: true, force: true });
  }
});
