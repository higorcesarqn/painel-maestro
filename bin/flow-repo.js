'use strict';
/**
 * flow-repo.js · which project a folder belongs to, by its git remote origin (works inside a worktree too,
 * since a worktree shares the main repository's configuration).
 *
 *   originOf(cwd)          → the origin URL, or null (not a git repository, or no origin)
 *   branchOf(cwd)          → the checked-out branch ("task/13-gerar-pdf"), or null (detached HEAD, no repository)
 *   normalizeRemote(url)   → "github.com/acme/widgets": host + path, lower case, without credentials, scheme,
 *                            ".git" or the "_git" of Azure DevOps; SSH and HTTPS forms give the same key
 *   describeRemote(url)    → { remote, tracker: 'github' | 'azure_devops', repo }  (repo: the repository name)
 *   repoInfo(cwd)          → { origin, branch } read from the .git files (the hook's fast path), or null
 *   parseBranch(name)      → what a branch name says about the flow (the single home of the branch convention):
 *       task/<item>-ajuste-final               { kind: 'final_adjustment', item }  the final adjustment floor: not a task
 *       task/<id>, task/<id>-…                 { kind: 'task', task }               the worker of task <id>
 *       feature/issue-<n>, feature/pbi-<id>…   { kind: 'maestro', item }            the maestro of the item (integration branch)
 *       anything else (or none)                { kind: 'other' }
 *     Used by the hook (bin/hook-log.js), by flow status/report (bin/flow.js) and mirrored by integrate.sh (skills).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function originOf(cwd) {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (r.error || r.status !== 0) return null;
  const url = String(r.stdout || '').trim();
  return url || null;
}

/** The checked-out branch of cwd (a floor's worktree has its own), or null (detached HEAD, not a repository). */
function branchOf(cwd) {
  const r = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (r.error || r.status !== 0) return null;
  return String(r.stdout || '').trim() || null;
}

const RE_FINAL_ADJUSTMENT_BRANCH = /^task\/(\d{1,9})-ajuste-final$/i;
const RE_TASK_BRANCH = /^task\/(\d{1,9})(?:[-_/.].*)?$/i;
const RE_ITEM_BRANCH = /^feature\/(?:pbi|issue)-(\d{1,9})(?:[-_/.].*)?$/i;

/** What a branch name says about the flow: { kind: 'final_adjustment'|'task'|'maestro'|'other', item?, task? }. */
function parseBranch(name) {
  const s = String(name || '');
  const positive = (m) => m && Number(m[1]) > 0;
  let m = RE_FINAL_ADJUSTMENT_BRANCH.exec(s);
  if (positive(m)) return { kind: 'final_adjustment', item: Number(m[1]) };
  m = RE_TASK_BRANCH.exec(s);
  if (positive(m)) return { kind: 'task', task: Number(m[1]) };
  m = RE_ITEM_BRANCH.exec(s);
  if (positive(m)) return { kind: 'maestro', item: Number(m[1]) };
  return { kind: 'other' };
}

function normalizeRemote(url) {
  let s = String(url || '').trim();
  if (!s) return '';
  // scp-like SSH: git@github.com:acme/widgets.git
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(s);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `${scp[1]}/${scp[2]}`;
  else s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]*@/, '');
  let [host, ...rest] = s.split('/');
  host = host.replace(/:\d+$/, '').toLowerCase();
  let p = rest.join('/').replace(/\/+$/, '').replace(/\.git$/i, '');
  // Azure DevOps: ssh.dev.azure.com/v3/org/project/repo and dev.azure.com/org/project/_git/repo are the same repo.
  if (host === 'ssh.dev.azure.com') {
    host = 'dev.azure.com';
    p = p.replace(/^v3\//i, '').replace(/^([^/]+)\/([^/]+)\/([^/]+)$/, '$1/$2/_git/$3');
  }
  if (host === 'vs-ssh.visualstudio.com') {
    p = p.replace(/^v3\//i, '');
    const m = /^([^/]+)\/([^/]+)\/([^/]+)$/.exec(p);
    if (m) { host = `${m[1].toLowerCase()}.visualstudio.com`; p = `${m[2]}/_git/${m[3]}`; }
  }
  return `${host}/${p}`.toLowerCase();
}

function describeRemote(url) {
  const remote = normalizeRemote(url);
  const [host, ...parts] = remote.split('/');
  const azure = host === 'dev.azure.com' || host.endsWith('.visualstudio.com');
  return { remote, tracker: azure ? 'azure_devops' : 'github', repo: parts[parts.length - 1] || host };
}

// ---------- fast reading for the hook (no process: spawning git costs ~65 ms on Windows) ----------

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** The .git of the folder (or of a parent), stopping at GIT_CEILING_DIRECTORIES like git: { gitDir, commonDir } or null. */
function findGitDir(cwd, env = process.env) {
  const ceilings = String(env.GIT_CEILING_DIRECTORIES || '').split(path.delimiter).filter(Boolean);
  let dir = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(dotGit); } catch (_) { st = null; }
    if (st && st.isDirectory()) return { gitDir: dotGit, commonDir: dotGit };
    if (st && st.isFile()) {
      // A worktree: ".git" is a file "gitdir: <path>" and <path>/commondir points to the main repository's .git.
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      if (!m) return null;
      const gitDir = path.resolve(dir, m[1]);
      let commonDir = gitDir;
      try { commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch (_) { /* not a worktree */ }
      return { gitDir, commonDir };
    }
    const parent = path.dirname(dir);
    if (parent === dir || ceilings.some((c) => samePath(parent, c))) return null;
    dir = parent;
  }
}

/** url of [remote "origin"] in a git config text; undefined when the config needs git itself (insteadOf, include). */
function originInConfig(text) {
  if (/insteadof|^\s*\[include/im.test(text)) return undefined;
  let inOrigin = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[\s*([^\]\s]+)(?:\s+"([^"]*)")?\s*\]/.exec(line);
    if (section) {
      inOrigin = section[1].toLowerCase() === 'remote' && section[2] === 'origin';
      continue;
    }
    const kv = inOrigin && /^url\s*=\s*(.*)$/i.exec(line);
    if (kv) return kv[1].replace(/^"(.*)"$/, '$1').trim() || null;
  }
  return null;
}

/**
 * Origin URL and current branch of the folder, reading the .git files (falls back to git for the origin when the
 * config is not plain). { origin, branch } (branch null when detached), or null outside a repository.
 */
function repoInfo(cwd, env = process.env) {
  let found;
  try { found = findGitDir(cwd, env); } catch (_) { return null; }
  if (!found) return null;
  let branch = null;
  try {
    const head = /^ref:\s*refs\/heads\/(.+?)\s*$/.exec(fs.readFileSync(path.join(found.gitDir, 'HEAD'), 'utf8'));
    branch = head ? head[1] : null;
  } catch (_) { branch = null; }
  let origin;
  try { origin = originInConfig(fs.readFileSync(path.join(found.commonDir, 'config'), 'utf8')); } catch (_) { origin = undefined; }
  if (origin === undefined) origin = originOf(cwd);
  return { origin: origin || null, branch };
}

module.exports = { originOf, branchOf, normalizeRemote, describeRemote, repoInfo, parseBranch };
