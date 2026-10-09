#!/usr/bin/env node
'use strict';
/*
 * servir-mock.js: serve o index.html no modo de teste (?mock=1), sem o servidor real e sem _maestro/.
 *
 * O navegador não deixa uma página aberta por file:// ler arquivos ao lado dela, então este
 * servidor mínimo entrega só quatro caminhos:
 *   /                            → painel/index.html
 *   /testes/mock-estado.json     → resposta fictícia de /api/estado
 *   /testes/mock-detalhes.json   → eventos completos, comandos brutos e fluxos (imitam /api/evento e /api/fluxo)
 *   /testes/mock-prospeccao.json → /api/prospeccao/estado e os leads (testes/gerar-mock-prospeccao.js)
 * Qualquer outro caminho é 404. Escuta só em 127.0.0.1, nas portas de teste 4790 a 4799 (nunca a 4777).
 *
 * Uso: node testes/servir-mock.js [porta]      (padrão 4795)
 *      e abra http://127.0.0.1:4795/?mock=1
 * Parar: Ctrl+C, ou taskkill //PID <pid impresso> //F no Git Bash.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const porta = Number(process.argv[2] || process.env.MOCK_PORTA || 4795);
if (!Number.isInteger(porta) || porta < 4790 || porta > 4799) {
  console.error(`Porta inválida: ${process.argv[2]}. Use uma porta de teste entre 4790 e 4799 (a 4777 é do painel real).`);
  process.exit(2);
}

const ARQUIVOS = {
  '/': [path.join(__dirname, '..', 'index.html'), 'text/html; charset=utf-8'],
  '/testes/mock-estado.json': [path.join(__dirname, 'mock-estado.json'), 'application/json; charset=utf-8'],
  '/testes/mock-detalhes.json': [path.join(__dirname, 'mock-detalhes.json'), 'application/json; charset=utf-8'],
  '/testes/mock-prospeccao.json': [path.join(__dirname, 'mock-prospeccao.json'), 'application/json; charset=utf-8'],
};
const HOSTS = new Set([`127.0.0.1:${porta}`, `localhost:${porta}`]);

const servidor = http.createServer((req, res) => {
  const responder = (status, corpo, tipo) => {
    res.writeHead(status, { 'Content-Type': tipo, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : corpo);
  };
  if (!HOSTS.has(String(req.headers.host || ''))) return responder(403, 'Host recusado.', 'text/plain; charset=utf-8');
  if (req.method !== 'GET' && req.method !== 'HEAD') return responder(405, 'Só GET.', 'text/plain; charset=utf-8');
  const caminho = new URL(req.url, `http://127.0.0.1:${porta}`).pathname;
  const alvo = ARQUIVOS[caminho];
  if (!alvo) return responder(404, 'Não existe no modo de teste.', 'text/plain; charset=utf-8');
  fs.readFile(alvo[0], (erro, buf) => {
    if (erro) return responder(404, `Arquivo ausente: ${path.basename(alvo[0])}`, 'text/plain; charset=utf-8');
    return responder(200, buf, alvo[1]);
  });
});

servidor.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `A porta ${porta} já está em uso.` : `Erro: ${e.message}`);
  process.exit(1);
});
servidor.listen(porta, '127.0.0.1', () => {
  console.log(`Mock do painel no ar em http://127.0.0.1:${porta}/?mock=1 (PID ${process.pid})`);
});
for (const sinal of ['SIGINT', 'SIGTERM']) process.on(sinal, () => servidor.close(() => process.exit(0)));
