'use strict';
// hook-failure.js · the hook's failure, made visible (#28). When maestro.db was written by a newer painel-maestro, the
// hook (bin/hook-log.js) cannot tell whether a session is ours and records nothing in bruto.db. Instead of swallowing
// it, it writes <MAESTRO_DIR>/hook-failure.json:
//   { at, error: { code: 'schema_too_new', file, db_version, code_version } }
// and the health badge (panel/health.js) shows hook_failed while that failure is newer than the hook's last entry in
// bruto.db: the next entry the hook records clears it, with no extra write on the hook's way.
const fs = require('fs');
const path = require('path');

const HOOK_FAILURE_FILE = 'hook-failure.json';

/** Writes the failure (whole file, temporary + rename); never throws: the hook must stay silent. */
function recordHookFailure(dir, at, error) {
  const file = path.join(dir, HOOK_FAILURE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ at, error }));
    fs.renameSync(tmp, file);
  } catch (_) {
    try { fs.rmSync(tmp, { force: true }); } catch (__) { /* nothing to do */ }
  }
}

/** The failure in a read of hook-failure.json ({ exists, data }): { at, error } in the format above, or null. */
function hookFailureOf(read) {
  const d = read && read.data;
  if (!d || typeof d !== 'object' || typeof d.at !== 'string' || !Number.isFinite(Date.parse(d.at))) return null;
  const e = d.error;
  if (!e || e.code !== 'schema_too_new' || !Number.isInteger(e.db_version) || !Number.isInteger(e.code_version)) return null;
  const file = typeof e.file === 'string' && e.file ? e.file.slice(0, 40) : 'maestro.db';
  return { at: d.at, error: { code: e.code, file, db_version: e.db_version, code_version: e.code_version } };
}

module.exports = { HOOK_FAILURE_FILE, recordHookFailure, hookFailureOf };
