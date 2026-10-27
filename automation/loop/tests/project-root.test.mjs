import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const config = fileURLToPath(new URL("../src/config.mjs", import.meta.url));
const probe = (value) => spawnSync(process.execPath, ["--input-type=module", "-e", `import {ROOT, TOOL_ROOT} from ${JSON.stringify(new URL("../src/config.mjs", import.meta.url).href)}; console.log(JSON.stringify({ROOT, TOOL_ROOT}))`], {
  env: { ...process.env, SOXU_PROJECT_ROOT: value }, encoding: "utf8",
});

test("explicit project root is independent from tool installation", () => {
  const target = resolve(config, "../../../../separate-project");
  const result = probe(target);
  assert.equal(result.status, 0, result.stderr);
  const paths = JSON.parse(result.stdout);
  assert.equal(paths.ROOT, target);
  assert.notEqual(paths.ROOT, paths.TOOL_ROOT);
});

test("relative and empty explicit project roots fail closed", () => {
  for (const target of ["relative-project", ""]) {
    const result = probe(target);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SOXU_PROJECT_ROOT must be a non-empty absolute path/);
  }
});

test("relocated CLI reads the target's legacy checkpoint without writing it", async () => {
  const base = await mkdtemp(join(tmpdir(), "soxu-split-"));
  const tool = join(base, "tool"), project = join(base, "project");
  try {
    await cp(new URL("../src", import.meta.url), join(tool, "automation/loop/src"), {recursive:true});
    await mkdir(join(project, "automation"), {recursive:true});
    await cp(join(process.env.SOXU_PROJECT_ROOT, "automation/policy.json"), join(project, "automation/policy.json"));
    await mkdir(join(project, "tasks/backlog"), {recursive:true});
    await writeFile(join(project, "tasks/backlog/TASK-001.md"), "# Target task\n");
    await mkdir(join(project, ".soxu/checkpoints"), {recursive:true});
    const checkpoint = JSON.stringify({issue:{number:1,title:"[TASK-001] Target task"}, local:true, status:"paused", phase:"checks"});
    await writeFile(join(project, ".soxu/checkpoints/issue-1.json"), checkpoint);
    const script = join(tool, "automation/loop/src/cli.mjs");
    const env = {...process.env, SOXU_PROJECT_ROOT: project};
    const result = spawnSync(process.execPath, [script, "status", "--local", "--json"], {cwd:tool, env, encoding:"utf8"});
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(result.stdout);
    assert.equal(state.paused[0].title, "Target task");
    assert.equal(state.paused[0].phase, "checks");
    const {readFile} = await import("node:fs/promises");
    assert.equal(await readFile(join(project, ".soxu/checkpoints/issue-1.json"), "utf8"), checkpoint);
  } finally { await rm(base, {recursive:true, force:true}); }
});
