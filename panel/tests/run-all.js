'use strict';
// Runs every panel test: node panel/tests/run-all.js [filter]
// Each test-*.js file runs in its own process; exits 1 if any fails.
// Test data lives in tests/tmp/<test>-<pid>/ and is deleted at the end (KEEP_TMP=1 keeps it).
// Test servers only use ports 4790 to 4799 (never 4777).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const files = fs.readdirSync(__dirname).filter((n) => /^test-.+\.js$/.test(n)).sort();
const filter = process.argv[2];
const chosen = filter ? files.filter((n) => n.includes(filter)) : files;
const start = Date.now();
const failures = [];

for (const name of chosen) {
  const r = spawnSync(process.execPath, [path.join(__dirname, name)], { stdio: 'inherit', windowsHide: true, timeout: 10 * 60 * 1000 });
  if (r.status !== 0) failures.push(`${name} (exit ${r.status === null ? r.signal || 'timed out' : r.status})`);
}

const tmp = path.join(__dirname, 'tmp');
try {
  if (fs.existsSync(tmp) && !fs.readdirSync(tmp).length) fs.rmdirSync(tmp);
} catch (_) { /* another process using it */ }

const secs = ((Date.now() - start) / 1000).toFixed(1);
if (failures.length) {
  console.log(`\nFAILED: ${failures.join(', ')} · ${chosen.length} file(s) in ${secs} s`);
  process.exitCode = 1;
} else {
  console.log(`\nALL OK: ${chosen.length} test file(s) in ${secs} s`);
}
