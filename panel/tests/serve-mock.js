#!/usr/bin/env node
'use strict';
/*
 * serve-mock.js: serves index.html in test mode (?mock=1), without the real server and without data.
 *
 * The browser does not let a page opened through file:// read files next to it, so this minimal server
 * delivers only three paths:
 *   /                          → panel/index.html
 *   /tests/mock-state.json     → fictitious answer of /api/state
 *   /tests/mock-details.json   → full events, raw commands and flows (imitate /api/event and /api/flow)
 * Any other path is 404. Listens only on 127.0.0.1, on the test ports 4790 to 4799 (never 4777).
 *
 * Usage: node tests/serve-mock.js [port]      (default 4795; or the MOCK_PORT variable)
 *        and open http://127.0.0.1:4795/?mock=1
 * Stop: Ctrl+C, or taskkill //PID <printed pid> //F in Git Bash.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.argv[2] || process.env.MOCK_PORT || 4795);
if (!Number.isInteger(port) || port < 4790 || port > 4799) {
  console.error(`Porta inválida: ${process.argv[2]}. Use uma porta de teste entre 4790 e 4799 (a 4777 é do painel real).`);
  process.exit(2);
}

const FILES = {
  '/': [path.join(__dirname, '..', 'index.html'), 'text/html; charset=utf-8'],
  '/tests/mock-state.json': [path.join(__dirname, 'mock-state.json'), 'application/json; charset=utf-8'],
  '/tests/mock-details.json': [path.join(__dirname, 'mock-details.json'), 'application/json; charset=utf-8'],
};
const HOSTS = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

const server = http.createServer((req, res) => {
  const respond = (status, body, type) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (!HOSTS.has(String(req.headers.host || ''))) return respond(403, 'Host recusado.', 'text/plain; charset=utf-8');
  if (req.method !== 'GET' && req.method !== 'HEAD') return respond(405, 'Só GET.', 'text/plain; charset=utf-8');
  const urlPath = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
  const target = FILES[urlPath];
  if (!target) return respond(404, 'Não existe no modo de teste.', 'text/plain; charset=utf-8');
  fs.readFile(target[0], (error, buf) => {
    if (error) return respond(404, `Arquivo ausente: ${path.basename(target[0])}`, 'text/plain; charset=utf-8');
    return respond(200, buf, target[1]);
  });
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `A porta ${port} já está em uso.` : `Erro: ${e.message}`);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Mock do painel no ar em http://127.0.0.1:${port}/?mock=1 (PID ${process.pid})`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
