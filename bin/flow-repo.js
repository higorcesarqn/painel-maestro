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
 */
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

module.exports = { originOf, branchOf, normalizeRemote, describeRemote };
