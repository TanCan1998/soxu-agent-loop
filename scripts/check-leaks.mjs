#!/usr/bin/env node
/**
 * 凭据与隐私泄漏检查（仓库门禁）。
 *
 * 扫描被 git 跟踪的文本文件，命中即失败：
 *   - 私钥块、GitHub/OpenAI/Slack/AWS 等常见凭据格式
 *   - 硬编码的 token / password / secret 赋值
 *   - 本机绝对路径（Windows 用户目录、macOS/Linux 家目录）
 *   - 不应入库的本地状态（.soxu/、dashboard.config.json 等）
 *
 * 用法：
 *   node scripts/check-leaks.mjs            扫描全部跟踪文件
 *   node scripts/check-leaks.mjs --staged   只扫描暂存区（pre-commit）
 *   node scripts/check-leaks.mjs --json     机器可读输出
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const MAX_BYTES = 2 * 1024 * 1024;

/** 每个规则：正则 + 说明。命中后整行会被打码，避免把密钥再打进日志。 */
const RULES = [
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { id: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/ },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'google-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  // 形如 token = "..." / password: '...' 的硬编码赋值
  { id: 'hardcoded-secret', re: /(?:^|[^\w-])(?:api[_-]?key|secret|password|passwd|token|access[_-]?token|auth[_-]?token|private[_-]?token|client[_-]?secret)\s*[:=]\s*['"][^'"]{8,}['"]/i },
  // 本机绝对路径会泄漏用户名与目录结构
  { id: 'home-path-win', re: /\b[A-Za-z]:\\Users\\[^\\\s'"]{2,}\\/ },
  { id: 'home-path-posix', re: /\/(?:Users|home)\/[A-Za-z0-9._-]{2,}\// },
];

/** 允许出现的例外：测试夹具里的假值、文档中的占位符。 */
const ALLOW = [
  /(?:^|\/)tests?\//,              // 测试目录内的假 token
  /(?:^|\/)docs?\//,              // 文档示例
  /\.md$/,
  /(?:^|\/)package-lock\.json$/,
];

/** 任何仓库都不该跟踪的本地状态。 */
const FORBIDDEN_PATHS = [
  { re: /(?:^|\/)dashboard\.config\.json$/, why: '本地控制台配置（含访问令牌）' },
  { re: /(?:^|\/)\.soxu\//, why: '本地运行状态目录' },
  { re: /(?:^|\/)\.state\//, why: '本地运行状态目录' },
  { re: /\.(?:log)$/i, why: '日志文件' },
];

const mask = line => line.replace(/[A-Za-z0-9_\-]{6,}/g, m => (m.length > 12 ? m.slice(0, 4) + '***' : '***'));

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function trackedFiles(staged) {
  const out = staged
    ? git('diff', '--cached', '--name-only', '--diff-filter=ACMR')
    : git('ls-files');
  return out.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
}

function isBinary(file) {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) return true;
    const buf = readFileSync(file);
    // NUL 字节即视为二进制
    return buf.includes(0);
  } catch { return true; }
}

function contentOf(file, staged) {
  if (staged) return git('show', ':' + file);
  return readFileSync(file, 'utf8');
}

function scan({ staged = false } = {}) {
  const findings = [];
  for (const file of trackedFiles(staged)) {
    const posix = file.replace(/\\/g, '/');
    for (const rule of FORBIDDEN_PATHS) {
      if (rule.re.test(posix)) findings.push({ file: posix, line: 0, rule: 'forbidden-path', why: rule.why, sample: '' });
    }
    if (isBinary(file)) continue;
    if (ALLOW.some(re => re.test(posix))) continue;
    let text;
    try { text = contentOf(file, staged); } catch { continue; }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 2000) continue;
      for (const rule of RULES) {
        if (rule.re.test(line)) {
          findings.push({ file: posix, line: i + 1, rule: rule.id, sample: mask(line.trim()).slice(0, 160) });
          break;
        }
      }
    }
  }
  return findings;
}

const argv = process.argv.slice(2);
const staged = argv.includes('--staged');
const json = argv.includes('--json');
const findings = scan({ staged });

if (json) {
  console.log(JSON.stringify({ findings }, null, 2));
} else if (findings.length === 0) {
  console.log(`✅ 未发现凭据或隐私泄漏（扫描范围：${staged ? '暂存区' : '全部跟踪文件'}）`);
} else {
  console.error(`❌ 发现 ${findings.length} 处可疑内容：`);
  for (const f of findings) {
    const at = f.line ? `:${f.line}` : '';
    console.error(`   ${f.file}${at}  [${f.rule}]${f.why ? ' ' + f.why : ''}`);
    if (f.sample) console.error(`      ${f.sample}`);
  }
  console.error('\n确属误报时：换成明显的占位值，或把文件放到 tests/ docs/ 下并在评审中说明。');
}
process.exitCode = findings.length === 0 ? 0 : 1;
