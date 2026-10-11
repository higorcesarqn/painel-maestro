'use strict';
/**
 * flow-diff.js · the diff summary of a worker's report (TaskDiff, #41): the files the task committed since it left the
 * integration branch, with the lines added and removed. flow report (bin/flow.js) computes it in the task's worktree
 * and records it in the task-report itself.
 *
 *   taskDiff(cwd, { sha, bases }) → { diff } | { reason, params }   never throws
 *     sha     the report's commit (--sha or the worktree's HEAD); without it there is no summary
 *     bases   the names to try, in order (--base, the item's pr.branch, integrationBranch of flow-repo.js); for each
 *             one the local ref and then origin/<name>; the first that resolves is base_ref
 *     diff    { base, base_ref, files: [{ path, added, removed, binary }], total: { files, added, removed },
 *               truncated, uncommitted }
 *             base = merge-base(base_ref, sha) and the diff goes from it to sha: only commits, so a task that left the
 *             integration branch before another one was integrated does not show the other's files. files in git's
 *             order (by path).
 *     reason  why there is no summary, a key of review.diff in the CLI dictionary (params fill it): noSha,
 *             unknownCommit, noBase, noMergeBase, gitTimeout, gitFailed (git's first error line; outside a repository
 *             too, though flow already refuses a folder without a git origin before it gets here)
 *   Every git call has a 10 s timeout, like the rest of flow-repo.js; the paths come raw (-z), never quoted.
 */
const { spawnSync } = require('child_process');

const GIT_TIMEOUT_MS = 10000;
const MAX_OUTPUT = 64 * 1024 * 1024;

/** A git call failed (timeout, error or an unexpected exit code): the summary is left out, for this reason. */
class GitFailed extends Error {
  constructor(reason, params) {
    super(reason);
    Object.assign(this, { reason, params });
  }
}

/** Runs git in cwd; GitFailed unless the exit code is one of okCodes. */
function git(cwd, args, okCodes = [0]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_OUTPUT });
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

// "-" is a binary file: its lines are #55's; until then it counts as 0.
const lineCount = (v) => (v === '-' ? 0 : Number(v));

/** Lines of "git diff --numstat -z -M": [{ path, added, removed, binary }]. */
function parseNumstat(out) {
  const parts = String(out).split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(parts[i]);
    if (!m) continue;
    let file = m[3];
    // A renamed file comes as "added\tremoved\t" followed by the old and the new path (the old one is #55's).
    if (file === '') {
      file = parts[i + 2];
      i += 2;
    }
    files.push({ path: file, added: lineCount(m[1]), removed: lineCount(m[2]), binary: false });
  }
  return files;
}

function taskDiff(cwd, { sha, bases }) {
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
      added: files.reduce((n, f) => n + f.added, 0),
      removed: files.reduce((n, f) => n + f.removed, 0),
    };
    return { diff: { base: from, base_ref: base.name, files, total, truncated: false, uncommitted: 0 } };
  } catch (e) {
    // Nothing here keeps the report from being recorded.
    if (e instanceof GitFailed) return { reason: e.reason, params: e.params };
    return { reason: 'gitFailed', params: { detail: String((e && e.message) || e) } };
  }
}

module.exports = { taskDiff };
