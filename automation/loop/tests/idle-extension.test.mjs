import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesSlowCommand, idleBudgetFor, extractCommand, IDLE_EXTENSION_DEFAULT_SECONDS, IDLE_EXTENSION_MAX_SECONDS } from "../src/idle-extension.mjs";

test("extractCommand 只认 command/code 字符串", () => {
  assert.equal(extractCommand({ command: "cargo test" }), "cargo test");
  assert.equal(extractCommand({ code: "cargo build" }), "cargo build");
  assert.equal(extractCommand({ command: "   " }), null);
  assert.equal(extractCommand({ args: "cargo test" }), null);
  assert.equal(extractCommand(null), null);
  assert.equal(extractCommand("cargo test"), null);
});

test("慢命令白名单精确匹配，伪装字符串不命中", () => {
  assert.equal(matchesSlowCommand("cargo test --workspace"), true);
  assert.equal(matchesSlowCommand("cargo build --release"), true);
  assert.equal(matchesSlowCommand("pnpm install --frozen-lockfile"), true);
  // 首个 token 不在允许列表 → 伪装不命中
  assert.equal(matchesSlowCommand("echo cargo test"), false);
  assert.equal(matchesSlowCommand("cargo-test"), false);
  assert.equal(matchesSlowCommand("ls -la"), false);
  assert.equal(matchesSlowCommand(""), false);
  // 前缀后面必须是边界，不能是更长 token 的一部分
  assert.equal(matchesSlowCommand("cargo testing-extra"), false);
});

test("idleBudgetFor 命中白名单时抬高预算，且不越过硬超时", () => {
  const base = 240000, hard = 2100000;
  assert.equal(idleBudgetFor({ command: "cargo test", baseIdleMs: base, extensionSeconds: 600, hardMs: hard }), 840000);
  assert.equal(idleBudgetFor({ command: "echo hi", baseIdleMs: base, extensionSeconds: 600, hardMs: hard }), base);
  // 硬超时只剩 30s 时，延时被 clamp 到 hard-1s，但绝不低于 base
  assert.equal(idleBudgetFor({ command: "cargo test", baseIdleMs: base, extensionSeconds: 600, hardMs: base + 30000 }), base + 29000);
  // 硬超时小于 base（异常配置）时保持 base 不变
  assert.equal(idleBudgetFor({ command: "cargo test", baseIdleMs: base, extensionSeconds: 600, hardMs: base - 1000 }), base);
  // extensionSeconds 超上限会被 clamp 到 1800
  assert.equal(idleBudgetFor({ command: "cargo test", baseIdleMs: base, extensionSeconds: 999999, hardMs: hard }), base + 1800000);
});

test("自定义前缀列表覆盖默认值", () => {
  // 自定义前缀仍受 BIN_ALLOWLIST 约束（cargo/pnpm/npm/yarn/node），"gradle" 不在名单内不命中。
  assert.equal(matchesSlowCommand("cargo run --example demo", ["cargo run"]), true);
  assert.equal(matchesSlowCommand("cargo test", ["cargo run"]), false);
  assert.equal(matchesSlowCommand("gradle build", ["gradle build"]), false);
});

test("默认常量在合理范围", () => {
  assert.equal(IDLE_EXTENSION_DEFAULT_SECONDS, 600);
  assert.equal(IDLE_EXTENSION_MAX_SECONDS, 1800);
});