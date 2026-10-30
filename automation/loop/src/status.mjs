import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readCheckpoint } from './checkpoint.mjs';
import { ROOT } from './config.mjs';

async function safeTasks(dir) {
  try {
    return (await readdir(dir))
      .filter(x => /^TASK-\d+\.md$/.test(x))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

/**
 * 任务文件的最后修改时间。
 * 没有 checkpoint 的任务（早期任务、从未被 agent 认领过）以及已归档任务
 * 过去 updatedAt 一律是 null，面板上就永远显示「更新 —」。
 * 用文件 mtime 兜底：归档时间 ≈ tasks/done 下那个文件的修改时间。
 */
async function fileMtime(dir, filename) {
  try { return (await stat(join(dir, filename))).mtime.toISOString(); }
  catch { return null; }
}

// Titles belong to task Markdown, not runtime checkpoints. Keep status readable
// even for older task files that do not have complete YAML frontmatter.
async function taskTitle(dir, filename) {
  const content = await readFile(join(dir, filename), 'utf8');
  return content.match(/^#[ \t]+(.+)$/m)?.[1].trim() || filename.slice(0, -3);
}

/** Offline project snapshot: local task files and checkpoints, NOT GitHub's live progress. */
export async function localProgress(root = ROOT, getCheckpoint = (id) => readCheckpoint(id)) {
  const backlogDir = join(root, 'tasks/backlog');
  const doneDir = join(root, 'tasks/done');
  const open = await safeTasks(backlogDir);
  const archived = await safeTasks(doneDir);
  const pending = [], running = [], paused = [], blocked = [], done = [];
  for (const file of open) {
    const id = Number(file.match(/\d+/)[0]);
    const [checkpoint, title] = await Promise.all([getCheckpoint(id), taskTitle(backlogDir, file)]);
    const item = { id, name:file, title, phase:checkpoint?.phase ?? null,
      updatedAt: checkpoint?.updatedAt ?? await fileMtime(backlogDir, file) };
    if (checkpoint?.status === 'done') done.push(item);
    else if (checkpoint?.status === 'paused') paused.push(item);
    else if (checkpoint?.status === 'blocked') blocked.push(item);
    else if (checkpoint?.status === 'running') running.push(item);
    else pending.push(item);
  }
  for (const file of archived) done.push({
    id:Number(file.match(/\d+/)[0]), name:file, title:await taskTitle(doneDir, file),
    phase:'archived', updatedAt: await fileMtime(doneDir, file)
  });
  return { source:'local-checkpoints', isLive:false, total:open.length+archived.length,
    done, pending, running, paused, blocked,
    note:'Local progress only. GitHub Issues/PR/CI and independently running Pi sessions are not queried.' };
}
