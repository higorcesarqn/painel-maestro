'use strict';
/**
 * flow-diff.js · the diff summary of a worker's report (TaskDiff, #41): the files the task committed since it left the
 * integration branch, with the lines added and removed. flow report (bin/flow.js) computes it in the task's worktree
 * and records it in the task-report itself.
 *
 *   taskDiff(cwd, { sha, bases, worktreeHead }) → { diff } | { reason, params }   never throws
 *     sha     the report's commit (--sha or the worktree's HEAD); without it there is no summary
 *     bases   the names to try, in order (--base, the item's pr.branch, integrationBranch of flow-repo.js); for each
 *             one the local ref and then origin/<name>; the first that resolves is base_ref
 *     worktreeHead  the HEAD of cwd when cwd is the task's own worktree (the report found the task by its branch),
 *             else null
 *     diff    { base, base_ref, files: [{ path, from?, added, removed, binary }], total: { files, added, removed },
 *               truncated, uncommitted }
 *             base = merge-base(base_ref, sha) and the diff goes from it to sha: only commits, so a task that left the
 *             integration branch before another one was integrated does not show the other's files. files in git's
 *             order (by path), at most MAX_FILES (truncated: true when there were more); total is over the whole
 *             diff. A binary file (#55) has binary: true and added/removed null: it counts in total.files and stays
 *             out of the line totals. A renamed one has from, the old path. uncommitted is the number of files
 *             changed outside a commit in the worktree (git status), counted only when sha is the HEAD of the task's
 *             own worktree (worktreeHead): another folder at the same commit, like the maestro's, does not count.
 *     reason  why there is no summary, a key of review.diff in the CLI dictionary (params fill it): noSha,
 *             unknownCommit, noBase, noMergeBase, gitTimeout, gitFailed (git's first error line; outside a repository
 *             too, though flow already refuses a folder without a git origin before it gets here)
 *   Every git call has a 10 s timeout, like the rest of flow-repo.js; the paths come raw (-z), never quoted.
 */
const { spawnSync } = require('child_process');

const GIT_TIMEOUT_MS = 10000;
const MAX_OUTPUT = 64 * 1024 * 1024;
const MAX_FILES = 200;

/** A git call failed (timeout, error or an unexpected exit code): the summary is left out, for this reason. */
class GitFailed extends Error {
  constructor(reason, params) {
    super(reason);
    Object.assign(this, { reason, params });
  }
}

/**
 * Runs git in cwd, without optional locks (git status never takes the index.lock of the worker's worktree); GitFailed
 * unless the exit code is one of okCodes.
 */
function git(cwd, args, okCodes = [0]) {
  const r = spawnSync('git', ['--no-optional-locks', ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_OUTPUT });
  if (r.error && r.error.code === 'ETIMEDOUT') throw new GitFailed('gitTimeout', { seconds: GIT_TIMEOUT_MS / 1000 });
  if (r.error) throw new GitFailed('gitFailed', { detail: r.error.message });
  if (!okCodes.includes(r.status)) {
    throw new GitFailed('gitFailed', { detail: String(r.stderr || '').trim().split(/\r?\n/)[0] || `exit ${r.status}` });
  }
  return r;
}

/** The commit a name resolves to, or null when git does not know it. */
function commitOf(cwd, name) {
  if (!name || name.startsWith('-')) return null;
  const r = git(cwd, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`], [0, 1]);
  return r.status === 0 ? String(r.stdout).trim().toLowerCase() || null : null;
}

/** { base: { name, sha } | null, tried }: the first base that resolves (the local ref, then origin/<name>) and every ref tried. */
function resolveBase(cwd, bases) {
  const tried = [];
  for (const name of bases.filter((b, i) => b && bases.indexOf(b) === i)) {
    for (const ref of [name, `origin/${name}`]) {
      tried.push(ref);
      const sha = commitOf(cwd, ref);
      if (sha) return { base: { name: ref, sha }, tried };
    }
  }
  return { base: null, tried };
}

/** Lines of "git diff --numstat -z -M": [{ path, from?, added, removed, binary }]; "-" in the counts is a binary file. */
function parseNumstat(out) {
  const parts = String(out).split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(parts[i]);
    if (!m) continue;
    const binary = m[1] === '-' || m[2] === '-';
    const counts = { added: binary ? null : Number(m[1]), removed: binary ? null : Number(m[2]), binary };
    // A renamed file comes as "added\tremoved\t" followed by the old and the new path.
    if (m[3] === '') {
      files.push({ path: parts[i + 2], from: parts[i + 1], ...counts });
      i += 2;
    } else {
      files.push({ path: m[3], ...counts });
    }
  }
  return files;
}

/**
 * The files changed outside a commit in the worktree (staged, not staged or untracked, each file of a new folder
 * counted): the entries of "git status --porcelain -z", where a renamed or copied one carries its old path as the
 * next part. Like any other call, a git status that fails or times out leaves the summary out (GitFailed).
 */
function uncommittedFiles(cwd) {
  const out = git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all']).stdout;
  const parts = String(out).split('\0');
  let n = 0;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].length < 4) continue;
    n++;
    if (/[RC]/.test(parts[i].slice(0, 2))) i++;
  }
  return n;
}

function taskDiff(cwd, { sha, bases, worktreeHead }) {
  if (!sha) return { reason: 'noSha', params: {} };
  try {
    const head = commitOf(cwd, sha);
    if (!head) return { reason: 'unknownCommit', params: { sha } };
    const { base, tried } = resolveBase(cwd, bases);
    if (!base) return { reason: 'noBase', params: { names: tried.join(', ') } };
    const mb = git(cwd, ['merge-base', base.sha, head], [0, 1]);
    const from = String(mb.stdout).trim().toLowerCase();
    if (mb.status !== 0 || !from) return { reason: 'noMergeBase', params: { sha, base: base.name } };
    const files = parseNumstat(git(cwd, ['diff', '--numstat', '-z', '-M', from, head]).stdout);
    const total = {
      files: files.length,
      added: files.reduce((n, f) => n + (f.added || 0), 0),
      removed: files.reduce((n, f) => n + (f.removed || 0), 0),
    };
    return {
      diff: {
        base: from, base_ref: base.name, files: files.slice(0, MAX_FILES), total, truncated: files.length > MAX_FILES,
        uncommitted: worktreeHead && worktreeHead === head ? uncommittedFiles(cwd) : 0,
      },
    };
  } catch (e) {
    // Nothing here keeps the report from being recorded.
    if (e instanceof GitFailed) return { reason: e.reason, params: e.params };
    return { reason: 'gitFailed', params: { detail: String((e && e.message) || e) } };
  }
}

module.exports = { taskDiff };
