'use strict';
// server-outdated.js · the health badge's server_outdated reason (#38): the code the server runs changed in git since
// it started (a git pull, or the Ground switching branches while an item of the painel-maestro itself is implemented).
//
//   createServerOutdatedCheck({ repoDir, startedCommit, cacheMs }) → { healthReasons() → Promise<[{code: 'server_outdated', ...}] | []> }
//
// What counts is a commit between the commit the server started on (bin/version.js, #36) and HEAD that touches a file
// the server runs: anything under bin/, the top-level .js files of panel/ and package.json. The UI source, the built
// index.html (read again on every request), tests, docs, ADRs and uncommitted edits do not count. Without git, or
// without the commit the server started on (a folder outside a clone), the check does not run and never warns.
// git runs at most once every cacheMs (default CACHE_MS; the page reads the state every 20 s), and the diff once per
// new HEAD. The tests shorten the cache with PANEL_OUTDATED_CACHE_MS (server.js).

const { execFile } = require('child_process');

const CACHE_MS = 5000;
const GIT_TIMEOUT_MS = 5000;

/** Paths (relative to the repository, with /) of the files the server runs. */
const runsOnServer = (file) => file.startsWith('bin/') || file === 'package.json' || /^panel\/[^/]+\.js$/.test(file);

function git(dir, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

/** HEAD as { full, short }, or null when it cannot be read. */
async function headOf(dir) {
  const out = await git(dir, ['log', '-1', '--format=%H %h', 'HEAD']);
  const m = out && /^([0-9a-f]{40,64}) ([0-9a-f]{4,})$/.exec(out.trim());
  return m ? { full: m[1], short: m[2] } : null;
}

/** The server_outdated reason between started and head; null when nothing it runs changed; undefined when git failed. */
async function outdatedReason(dir, started, head) {
  if (head.full.startsWith(started)) return null;
  // --no-renames: a file renamed out of (or into) what the server runs counts on both sides.
  const out = await git(dir, ['diff', '--name-only', '--no-renames', '-z', started, head.full]);
  if (out === null) return undefined;
  const changed = out.split('\0').some((f) => f && runsOnServer(f));
  return changed ? { code: 'server_outdated', started_commit: started, head_commit: head.short } : null;
}

function createServerOutdatedCheck({ repoDir, startedCommit, cacheMs = CACHE_MS }) {
  let checkedAt = -Infinity;
  let cachedReasons = [];
  let running = null;
  let lastHead = null;   // the HEAD of the last diff: the diff runs again only when HEAD moves
  let lastReason = null;

  async function refresh() {
    const head = await headOf(repoDir);
    if (!head) return [];
    if (head.full !== lastHead) {
      const reason = await outdatedReason(repoDir, startedCommit, head);
      if (reason === undefined) return [];   // git failed: try this HEAD again after the cache
      lastReason = reason;
      lastHead = head.full;
    }
    return lastReason ? [lastReason] : [];
  }

  return {
    /** The reasons for the health badge now (from a cache of up to cacheMs); never rejects. */
    async healthReasons() {
      if (!startedCommit) return [];
      if (Date.now() - checkedAt < cacheMs) return cachedReasons;
      if (!running) {
        running = refresh().catch(() => []).then((r) => {
          cachedReasons = r;
          checkedAt = Date.now();
          running = null;
          return r;
        });
      }
      return running;
    },
  };
}

module.exports = { createServerOutdatedCheck, CACHE_MS };
