/**
 * 延时申请：Worker 在 Pi 即将执行长耗时命令（cargo build/test 等）时主动申请延长
 * idle 预算，符合白名单才批准。设计约束：
 *
 * - 命令只来自 tool_execution_start 事件的 args，且逐字段过白名单，禁止任意注入；
 * - 批准只延长 idle 窗口，绝不放宽带数上限（piHardMinutes）——真正的失控任务仍会被
 *   硬超时截断；
 * - 默认白名单覆盖 Rust 工具链与常见慢命令，policy 可覆盖。
 */

const DEFAULT_IDLE_EXTENSION_SECONDS = 600;
const MAX_IDLE_EXTENSION_SECONDS = 1800;

/** 判定“慢命令”的默认白名单：命令前缀（首个 token 及其常见子命令组合）。 */
const DEFAULT_SLOW_PREFIXES = [
  "cargo test",
  "cargo build",
  "cargo clippy",
  "cargo check",
  "cargo fmt",
  "cargo doc",
  "cargo bench",
  "cargo install",
  "cargo fetch",
  "pnpm install",
  "pnpm test",
  "npm install",
  "npm test",
  "yarn install",
  "pnpm build",
  "npm run build",
];

const BIN_ALLOWLIST = new Set(["cargo", "pnpm", "npm", "yarn", "node"]);

/**
 * 从 tool_execution_start.args 中提取可判定的命令文本。
 * 支持的形状：{command: string}（powershell/bash/codemode 类）、{code: string}（codemode）。
 * 其余形状一律返回 null：宁可漏判也不误判。
 */
export function extractCommand(args) {
  if (!args || typeof args !== "object") return null;
  for (const key of ["command", "code"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function normalizeCommand(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

/**
 * 判断命令是否命中慢命令白名单。
 * 命中条件：命令串中出现“白名单前缀 + 边界”，且首个 token 在 BIN_ALLOWLIST 里。
 * （首个 token 校验避免 `echo cargo test` 这类伪装字符串命中。）
 */
export function matchesSlowCommand(command, prefixes = DEFAULT_SLOW_PREFIXES) {
  const normalized = normalizeCommand(command);
  if (!normalized) return false;
  const firstToken = normalized.split(" ")[0];
  if (!BIN_ALLOWLIST.has(firstToken)) return false;
  return prefixes.some(prefix => {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("(^|[^a-zA-Z0-9_-])" + escaped + "($|[ \\t;&|])").test(normalized);
  });
}

/**
 * 计算“这一轮工具调用”的 idle 预算（毫秒）。
 * 默认 = 原始 idle；命中慢命令 = base + extension（clamp 到硬超时之内）。
 */
export function idleBudgetFor({ command, baseIdleMs, extensionSeconds = DEFAULT_IDLE_EXTENSION_SECONDS, hardMs, prefixes }) {
  const extensionMs = Math.max(0, Math.min(extensionSeconds, MAX_IDLE_EXTENSION_SECONDS)) * 1000;
  if (!matchesSlowCommand(command, prefixes)) return baseIdleMs;
  if (!Number.isFinite(hardMs)) return baseIdleMs + extensionMs;
  // 延时永不越过硬超时；留 1s 余量保证 watchdog 仍能触发 fail。
  return Math.min(baseIdleMs + extensionMs, Math.max(baseIdleMs, hardMs - 1000));
}

export const SLOW_COMMAND_DEFAULTS = Object.freeze([...DEFAULT_SLOW_PREFIXES]);
export const IDLE_EXTENSION_DEFAULT_SECONDS = DEFAULT_IDLE_EXTENSION_SECONDS;
export const IDLE_EXTENSION_MAX_SECONDS = MAX_IDLE_EXTENSION_SECONDS;