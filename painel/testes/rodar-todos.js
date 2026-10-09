'use strict';
// Roda todos os testes do painel: node painel/testes/rodar-todos.js
// Cada arquivo teste-*.js roda num processo próprio; sai 1 se algum falhar.
// Dados de teste ficam em testes/tmp/<teste>-<pid>/ e são apagados no fim (MANTER_TMP=1 guarda).
// Servidores de teste usam só as portas 4790 a 4799 (nunca a 4777).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const arquivos = fs.readdirSync(__dirname).filter((n) => /^teste-.+\.js$/.test(n)).sort();
const filtro = process.argv[2];
const escolhidos = filtro ? arquivos.filter((n) => n.includes(filtro)) : arquivos;
const inicio = Date.now();
const falhas = [];

for (const nome of escolhidos) {
  const r = spawnSync(process.execPath, [path.join(__dirname, nome)], { stdio: 'inherit', windowsHide: true, timeout: 10 * 60 * 1000 });
  if (r.status !== 0) falhas.push(`${nome} (saída ${r.status === null ? r.signal || 'tempo esgotado' : r.status})`);
}

const tmp = path.join(__dirname, 'tmp');
try {
  if (fs.existsSync(tmp) && !fs.readdirSync(tmp).length) fs.rmdirSync(tmp);
} catch (_) { /* outro processo usando */ }

const seg = ((Date.now() - inicio) / 1000).toFixed(1);
if (falhas.length) {
  console.log(`\nFALHOU: ${falhas.join(', ')} · ${escolhidos.length} arquivo(s) em ${seg} s`);
  process.exitCode = 1;
} else {
  console.log(`\nTUDO OK: ${escolhidos.length} arquivo(s) de teste em ${seg} s`);
}
