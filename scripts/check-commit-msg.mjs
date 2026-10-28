#!/usr/bin/env node
/**
 * SOXU mandatory commit format:
 *   <gitmoji> type(scope): description
 * Validate a commit-msg hook file, a literal message, or a range of commits.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const COMMIT_TYPES = Object.freeze([
  'feat', 'fix', 'docs', 'style', 'refactor', 'test',
  'chore', 'perf', 'build', 'ci', 'revert',
]);

export const GITMOJI = Object.freeze({
  feat: '✨',
  fix: '🐛',
  docs: '📚',
  style: '💎',
  refactor: '♻️',
  test: '🧪',
  chore: '🔧',
  perf: '⚡',
  build: '📦',
  ci: '👷',
  revert: '⏪',
});

export function validateCommitMessage(message) {
  const firstLine = message.split(/\r?\n/, 1)[0];
  const match = /^(\S+) ([a-z]+)\(([a-z0-9][a-z0-9._/-]*)\): (.+)$/u.exec(firstLine);

  if (!match) {
    return `提交格式必须为 <gitmoji> type(scope): 描述，实际为：${JSON.stringify(firstLine)}`;
  }

  const [, gitmoji, type, , description] = match;
  if (!COMMIT_TYPES.includes(type)) {
    return `不支持的 type: ${type}；允许值：${COMMIT_TYPES.join(', ')}`;
  }
  if (GITMOJI[type] !== gitmoji) {
    return `Gitmoji 与 type 不匹配：${type} 必须使用 ${GITMOJI[type]}，当前为 ${gitmoji}`;
  }
  if (!description.trim() || description !== description.trimEnd()) {
    return '提交描述不能为空，也不能包含末尾空格';
  }
  return null;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}

function isAncestor(base, head) {
  try {
    git('merge-base', '--is-ancestor', base, head);
    return true;
  } catch {
    return false;
  }
}

function checkOne(message, label = '当前提交') {
  const error = validateCommitMessage(message);
  if (error) {
    console.error(`❌ ${label}：${error}`);
    return false;
  }
  console.log(`✅ ${label}：${message.split(/\r?\n/, 1)[0]}`);
  return true;
}

function usage() {
  console.error('用法：node scripts/check-commit-msg.mjs <message-file>');
  console.error('      node scripts/check-commit-msg.mjs --message "🔧 chore(repo): initial commit"');
  console.error('      node scripts/check-commit-msg.mjs --range <base-sha> <head-sha>');
}

function main(argv) {
  if (argv.length === 1 && !argv[0].startsWith('--')) {
    return checkOne(readFileSync(argv[0], 'utf8')) ? 0 : 1;
  }
  if (argv[0] === '--message' && argv.length === 2) {
    return checkOne(argv[1]) ? 0 : 1;
  }
  if (argv[0] === '--range' && argv.length === 3) {
    const [, base, head] = argv;
    if (!/^[0-9a-f]{40,64}$/i.test(base) || !/^[0-9a-f]{40,64}$/i.test(head)) {
      console.error('❌ --range 要求完整的 Git SHA（40 或 64 位十六进制）');
      return 2;
    }
    const zero = /^0+$/.test(base);
    // 强推或历史重写后，push 事件的 before 不在新 HEAD 的祖先链上，
    // `base..head` 是非法区间。此时只校验新 tip 并说明原因，不让门禁误报失败。
    if (!zero && !isAncestor(base, head)) {
      console.log(
        `⚠️ 基线 ${base.slice(0, 10)} 不在 ${head.slice(0, 10)} 的历史中（历史重写或强推），仅校验最新提交`
      );
      return checkOne(git('show', '-s', '--format=%B', head), head.slice(0, 10)) ? 0 : 1;
    }
    const selector = zero ? head : `${base}..${head}`;
    const commits = git('rev-list', '--reverse', selector).trim().split(/\r?\n/).filter(Boolean);
    if (commits.length === 0) {
      console.log('✅ 没有需要检查的新提交');
      return 0;
    }
    let ok = true;
    for (const sha of commits) {
      const message = git('show', '-s', '--format=%B', sha);
      // Check every commit; do not silently exempt merge/revert commits.
      if (!checkOne(message, sha.slice(0, 10))) ok = false;
    }
    return ok ? 0 : 1;
  }
  usage();
  return 2;
}

// Prevent executing CLI when imported from unit tests.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`❌ 提交消息校验失败：${error.message}`);
    process.exitCode = 2;
  }
}
