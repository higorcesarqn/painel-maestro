'use strict';
// Panel test helpers (no framework). Everything written goes under tests/tmp/.

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP = path.join(__dirname, 'tmp');
const REPO = path.resolve(__dirname, '..', '..');
const PORTS = [4790, 4791, 4792, 4793, 4794, 4795, 4796, 4797, 4798, 4799];

/** Simple suite: test(name, fn) in sequence and run() at the end (exit code 1 on failure). */
function createSuite(title) {
  const cases = [];
  let passed = 0;
  let failed = 0;
  return {
    test(name, fn) {
      cases.push({ name, fn });
    },
    async run() {
      console.log(`\n== ${title}`);
      for (const c of cases) {
        const t0 = Date.now();
        try {
          await c.fn();
          passed++;
          console.log(`ok    ${c.name} (${Date.now() - t0} ms)`);
        } catch (e) {
          failed++;
          const stack = String((e && e.stack) || e).split('\n').slice(0, 8).join('\n        ');
          console.log(`FAIL  ${c.name}\n        ${stack}`);
        }
      }
      console.log(`-- ${title}: ${passed} ok · ${failed} failed`);
      process.exitCode = failed ? 1 : 0;
      return { passed, failed };
    },
  };
}

/** The test's own temporary folder (deleted and recreated). */
function tmpDir(name) {
  const d = path.join(TMP, `${name}-${process.pid}`);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function remove(d) {
  try {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (_) { /* antivirus holding it: left for next time */ }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function writeJsonl(file, lines, { noFinalNewline = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
  fs.writeFileSync(file, noFinalNewline ? text : `${text}\n`);
}

function append(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, text);
}

/** Claude Code transcript "assistant" line with the given usage. */
function assistantLine({ id, ts, i = 0, o = 0, cw = 0, cr = 0, session = 'session', sub = false, stop = 'end_turn' }) {
  return JSON.stringify({
    parentUuid: null, isSidechain: sub, type: 'assistant', uuid: `u-${id}-${Math.random().toString(16).slice(2, 8)}`,
    timestamp: new Date(ts).toISOString(), sessionId: session, cwd: 'C:\\test',
    message: {
      model: 'claude-opus-5-5', id, type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: stop,
      usage: { input_tokens: i, output_tokens: o, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, service_tier: 'standard' },
    },
    requestId: `req-${id}`,
  });
}

function userLine(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: new Date().toISOString(), usage_hint: 'none' });
}

/** A free port between 4790 and 4799 (never 4777). */
async function freePort() {
  const order = PORTS.slice().sort(() => Math.random() - 0.5);
  for (const p of order) {
    const free = await new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (free) return p;
  }
  throw new Error('No free port between 4790 and 4799');
}

/** Raw HTTP request (no gzip), with Host and headers of choice. */
function request(port, urlPath, { method = 'GET', host, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const all = Object.assign({ Host: host === undefined ? `127.0.0.1:${port}` : host }, headers);
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: all, agent: false }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(parts);
        const text = buf.toString('utf8');
        let json = null;
        if (/json/.test(String(res.headers['content-type'] || '')) && !res.headers['content-encoding']) {
          try { json = JSON.parse(text); } catch (_) { json = null; }
        }
        resolve({ status: res.statusCode, headers: res.headers, text, buf, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error(`timed out on ${urlPath}`)));
    if (body) req.write(body);
    req.end();
  });
}

/** Raw request over the socket (for empty, missing or duplicated Host). Returns {status, text}. */
function rawRequest(port, text) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.end(text));
    const parts = [];
    s.on('data', (c) => parts.push(c));
    s.on('error', reject);
    s.on('close', () => {
      const t = Buffer.concat(parts).toString('utf8');
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(t);
      resolve({ status: m ? Number(m[1]) : null, text: t });
    });
    s.setTimeout(15000, () => s.destroy(new Error('timed out')));
  });
}

async function waitFor(fn, ms = 8000, step = 50) {
  const end = Date.now() + ms;
  for (;;) {
    const r = await fn();
    if (r) return r;
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((x) => setTimeout(x, step));
  }
}

/** Kills a process by its Windows PID (taskkill /F), without a shell. */
function kill(pid) {
  if (!pid) return;
  try { process.kill(pid); } catch (_) { /* already gone */ }
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

module.exports = {
  assert, TMP, REPO, createSuite, tmpDir, remove, writeJson, writeJsonl, append,
  assistantLine, userLine, freePort, request, rawRequest, waitFor, kill, pidAlive,
};
