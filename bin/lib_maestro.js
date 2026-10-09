'use strict';
/**
 * lib_maestro.js · funções comuns dos comandos de _maestro/bin (Node 18+, só biblioteca padrão, CommonJS).
 *
 * Seções: caminhos · datas (America/Sao_Paulo) · trava e JSON de estado · JSONL · entrada padrão ·
 * redação de segredos e truncamento · agentes e identificação · eventos do log semântico ·
 * sessões e fluxos · correlação com o log bruto · argumentos e códigos de saída.
 *
 * Variáveis de ambiente:
 *   MAESTRO_DIR    raiz do _maestro (padrão: a pasta acima de bin/). Os testes apontam para uma pasta temporária.
 *   MAESTRO_TRAVA  exlock|wx força a estratégia de trava (todos os processos precisam usar a mesma).
 *   MAESTRO_TRAVA_ESPERA_MS  espera máxima pela trava nos comandos (padrão 10000).
 *   MAESTRO_AGORA  data/hora fixa em ISO 8601. Só para testes.
 *
 * Regras de gravação (validadas na Fase 0 com 8 processos simultâneos no Windows/NTFS):
 *   - Logs JSONL: anexarJsonl = UMA chamada de fs.appendFileSync por linha, sem trava (atômico no NTFS).
 *     Nunca gravar uma linha em duas chamadas: no teste isso corrompeu 969 de 2400 linhas.
 *   - JSON de estado: atualizarJson = trava + leitura + gravação atômica (temporário + rename com novas
 *     tentativas em EPERM/EBUSY). Nunca sobrescreve um JSON corrompido.
 *   - O hook nunca espera trava por mais de ~300 ms (passa tempoMaximoMs) e desiste em silêncio.
 *   - Datas sempre com isoSP() (offset de São Paulo). Nunca toISOString() nos dados.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// Carregados só quando precisa: o hook roda a cada ferramenta e cada milissegundo conta.
let moduloCrypto = null;
let moduloZlib = null;
const cripto = () => moduloCrypto || (moduloCrypto = require('crypto'));
const zlib = () => moduloZlib || (moduloZlib = require('zlib'));

/** Sufixo aleatório em hexadecimal para nomes temporários e ids (não precisa de força criptográfica). */
function aleatorioHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes; i++) s += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  return s;
}

// =============================================================================================
// Caminhos
// =============================================================================================

/** Raiz do _maestro: a variável MAESTRO_DIR ou a pasta acima de bin/. */
function dirMaestro() {
  return path.resolve(process.env.MAESTRO_DIR || path.join(__dirname, '..'));
}

/** Raiz do workspace deduzida sem ler arquivo nenhum: a pasta que contém o _maestro. */
function raizPadrao() {
  return path.dirname(dirMaestro());
}

/** Caminhos dos dados, recalculados a cada chamada (respeitam MAESTRO_DIR). */
function caminhos() {
  const base = dirMaestro();
  const logs = path.join(base, 'logs');
  const estado = path.join(base, 'estado');
  return {
    base,
    logs,
    estado,
    agentes: path.join(base, 'registro', 'agentes.json'),
    eventos: path.join(logs, 'eventos'),
    bruto: path.join(logs, 'bruto'),
    preRegistro: path.join(logs, 'pre-registro.md'),
    contadorFluxos: path.join(estado, 'contador-fluxos.json'),
    pendencias: path.join(estado, 'pendencias.json'),
    sessoes: path.join(estado, 'sessoes'),
    travaSessoes: path.join(estado, 'sessoes.lock'), // uma trava só para todos os arquivos de sessão
  };
}

/** Caminho com barras normais (para mostrar e gravar). */
function barras(p) {
  return String(p).replace(/\\/g, '/');
}

/** Tira acentos (NFD sem marcas combinantes), mantendo maiúsculas e minúsculas. */
function tirarAcentos(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Nome de pasta seguro para um slug ("desconhecido:x" vira "desconhecido-x"). */
function pastaDoSlug(slug) {
  const s = tirarAcentos(String(slug || '')).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80);
  return s || 'desconhecido';
}

/** Arquivo do log semântico do mês da data: logs/eventos/AAAA-MM.jsonl. */
function arquivoEventos(data = agora()) {
  return path.join(caminhos().eventos, `${carimbosSP(data).aaaamm}.jsonl`);
}

/** Arquivo do log bruto do agente no dia da data: logs/bruto/<slug>/AAAA-MM-DD.jsonl. */
function arquivoBruto(slug, data = agora()) {
  return path.join(caminhos().bruto, pastaDoSlug(slug), `${carimbosSP(data).aaaammdd}.jsonl`);
}

/** Higieniza um session_id para virar nome de arquivo (só letras, números, _ e -). */
function idSessaoSeguro(sessionId) {
  return String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128);
}

/** Arquivo de estado da sessão: estado/sessoes/<session_id>.json. */
function arquivoSessao(sessionId) {
  const id = idSessaoSeguro(sessionId);
  if (!id) throw new Error('session_id vazio ou inválido');
  return path.join(caminhos().sessoes, `${id}.json`);
}

/** Normaliza um caminho para comparar: absoluto, barras normais, minúsculas, sem barra final (aceita /c/... do Git Bash). */
function normalizarCaminho(p) {
  if (typeof p !== 'string' || !p.trim()) return '';
  let s = p.trim().replace(/\\/g, '/');
  const m = /^\/([a-zA-Z])(\/|$)/.exec(s);
  if (m) s = `${m[1]}:/${s.slice(3)}`;
  s = path.resolve(s).replace(/\\/g, '/');
  return s.replace(/\/+$/, '').toLowerCase();
}

/** true se "filho" é o próprio "pai" ou fica dentro dele (depois de normalizar). */
function dentroDe(filho, pai) {
  const f = normalizarCaminho(filho);
  const p = normalizarCaminho(pai);
  if (!f || !p) return false;
  return f === p || f.startsWith(`${p}/`);
}

// =============================================================================================
// Datas no fuso America/Sao_Paulo (Intl/ICU: se o horário de verão voltar, o offset muda sozinho)
// =============================================================================================

const FUSO = 'America/Sao_Paulo';
// Criados no primeiro uso: carregar os dados de fuso do ICU custa ~20-40 ms por processo.
let fmtSP = null;
let fmtExtenso = null;
const formatadorSP = () => fmtSP || (fmtSP = new Intl.DateTimeFormat('en-US', {
  timeZone: FUSO,
  hourCycle: 'h23', // meia-noite sai "00", nunca "24"
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  timeZoneName: 'longOffset', // "GMT-03:00" ("GMT" quando o offset é zero)
}));
const formatadorExtenso = () => fmtExtenso || (fmtExtenso = new Intl.DateTimeFormat('pt-BR', {
  timeZone: FUSO, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
}));
const RE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Data/hora atual (ou MAESTRO_AGORA, só para testes). */
function agora() {
  const fixo = process.env.MAESTRO_AGORA;
  if (fixo) {
    const d = new Date(fixo);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

/** Partes da data em São Paulo: {ano, mes, dia, hora, minuto, segundo, offset:'-03:00'}. */
function partesSP(data = agora()) {
  const p = {};
  for (const { type, value } of formatadorSP().formatToParts(data)) p[type] = value;
  const offset = p.timeZoneName === 'GMT' ? '+00:00' : p.timeZoneName.slice(3);
  return { ano: p.year, mes: p.month, dia: p.day, hora: p.hour, minuto: p.minute, segundo: p.second, offset };
}

/** ISO 8601 com offset de São Paulo, sem milissegundos: 2026-10-08T15:41:02-03:00. */
function isoSP(data = agora()) {
  const p = partesSP(data);
  return `${p.ano}-${p.mes}-${p.dia}T${p.hora}:${p.minuto}:${p.segundo}${p.offset}`;
}

/** Formato de interface: 08/10/2026 15:41. */
function dataHoraBR(data = agora()) {
  const p = partesSP(data);
  return `${p.dia}/${p.mes}/${p.ano} ${p.hora}:${p.minuto}`;
}

/** Só a data: 08/10/2026. */
function dataBR(data = agora()) {
  const p = partesSP(data);
  return `${p.dia}/${p.mes}/${p.ano}`;
}

/** Só a hora com segundos: 15:41:02. */
function horaBR(data = agora()) {
  const p = partesSP(data);
  return `${p.hora}:${p.minuto}:${p.segundo}`;
}

/** Carimbos para arquivos e ids: {aaaamm:'2026-10', aaaammdd:'2026-10-08', compacto:'20261008', hhmmss:'154102'}. */
function carimbosSP(data = agora()) {
  const p = partesSP(data);
  return {
    aaaamm: `${p.ano}-${p.mes}`,
    aaaammdd: `${p.ano}-${p.mes}-${p.dia}`,
    compacto: `${p.ano}${p.mes}${p.dia}`,
    hhmmss: `${p.hora}${p.minuto}${p.segundo}`,
  };
}

/** Converte texto ISO 8601 com fuso (ou Date) em Date; devolve null se inválido. */
function lerData(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string' || !RE_ISO.test(v.trim())) return null;
  const d = new Date(v.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Dia por extenso em português: "quinta-feira, 08/10/2026". */
function diaPorExtenso(data = agora()) {
  return formatadorExtenso().format(data);
}

/** Idade legível de uma data: "agora", "há 5 min", "há 3 h", "há 2 d". */
function idadeLegivel(data, referencia = agora()) {
  const d = lerData(data);
  if (!d) return '?';
  const s = Math.round((referencia.getTime() - d.getTime()) / 1000);
  if (s < 0) return 'no futuro';
  if (s < 60) return 'agora';
  const min = Math.floor(s / 60);
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `há ${h} h`;
  return `há ${Math.floor(h / 24)} d`;
}

// =============================================================================================
// Trava entre processos e gravação segura (base: Fase 0, lib-trava.js; 800/800 no contador 8x100)
//  - Windows ('exlock', padrão): abre "<alvo>.lock" com compartilhamento exclusivo (flag
//    UV_FS_O_EXLOCK = 0x10000000 da libuv). Outro processo recebe EBUSY. Se o dono morrer, o Windows
//    fecha o handle e a trava some sozinha. O .lock fica no disco, vazio, e é reaproveitado.
//  - Outros sistemas ('wx'): cria "<alvo>.lock" com O_CREAT|O_EXCL e apaga ao liberar; detecta trava
//    velha (PID morto, idade) mas nunca quebra trava mais nova que idadeMinimaMs.
//  - Espera: nos primeiros 50 ms, espera ativa de ~0,1 ms (o menor sono real do Windows é 11-16 ms).
//  - Sem trava até tempoMaximoMs: Error com code 'ETRAVA_TEMPO'.
// =============================================================================================

const HOST = os.hostname();
const UV_FS_O_EXLOCK = 0x10000000; // libuv (uv/win.h); o Node não exporta a constante
const FLAGS_EXLOCK = fs.constants.O_RDWR | fs.constants.O_CREAT | UV_FS_O_EXLOCK;
const CODIGOS_OCUPADO = new Set(['EEXIST', 'EBUSY', 'EPERM', 'EACCES']);
const celulaEspera = new Int32Array(new SharedArrayBuffer(4));
const travasAbertas = new Set();

const PADRAO_TRAVA = {
  estrategia: process.env.MAESTRO_TRAVA || (process.platform === 'win32' ? 'exlock' : 'wx'),
  tempoMaximoMs: Number(process.env.MAESTRO_TRAVA_ESPERA_MS) > 0 ? Number(process.env.MAESTRO_TRAVA_ESPERA_MS) : 10000, // espera máxima pela trava
  faseRapidaMs: 50, // tempo inicial com espera ativa curta
  idadeMinimaMs: 2000, // 'wx': nunca quebra trava mais nova que isso
  idadeVelhaMs: 30000, // 'wx': trava mais velha que isso é abandonada
  idadeVaziaMs: 5000, // 'wx': .lock vazio mais velho que isso é abandonado
  checagemVelhaMs: 100, // 'wx': intervalo entre leituras do .lock
};

/** Dorme sem gastar CPU (no Windows, na prática, no mínimo ~11-16 ms). */
function dormir(ms) {
  Atomics.wait(celulaEspera, 0, 0, Math.max(1, Math.round(ms)));
}

/** Espera ativa curtinha (gasta CPU, mas responde em décimos de milissegundo). */
function esperaAtiva(ms) {
  const fim = process.hrtime.bigint() + BigInt(Math.round(ms * 1e6));
  while (process.hrtime.bigint() < fim) { /* gira */ }
}

/** Espera um pouco antes de tentar de novo: ativa no começo, sono depois. */
function aguardarVez(inicio, faseRapidaMs) {
  if (Date.now() - inicio < faseRapidaMs) esperaAtiva(0.05 + Math.random() * 0.15);
  else dormir(1 + Math.random() * 4);
}

/** true se o PID existe neste computador (EPERM = existe, mas é de outro usuário). */
function pidVivo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function lerTravaWx(arquivoTrava) {
  let st;
  try { st = fs.statSync(arquivoTrava, { bigint: true }); } catch (e) {
    return e.code === 'ENOENT' ? null : { ino: null };
  }
  let dono = null;
  try { dono = JSON.parse(fs.readFileSync(arquivoTrava, 'utf8')); } catch { /* vazio ou sendo apagado */ }
  return { ino: st.ino, mtimeMs: Number(st.mtimeMs), dono };
}

function travaWxVelha(info, op) {
  if (!info || info.ino === null) return false;
  const d = info.dono;
  const temDono = d && typeof d.desde === 'number';
  const idade = Date.now() - (temDono ? d.desde : info.mtimeMs);
  if (idade < op.idadeMinimaMs) return false;
  if (temDono) return (d.host === HOST && !pidVivo(d.pid)) || idade > op.idadeVelhaMs;
  return idade > op.idadeVaziaMs;
}

function quebrarTravaWx(arquivoTrava, infoVelha) {
  // Reconfere logo antes: se o .lock já é outro arquivo, a trava velha já foi trocada.
  try { if (fs.statSync(arquivoTrava, { bigint: true }).ino !== infoVelha.ino) return false; } catch { return false; }
  const temporario = `${arquivoTrava}.velha-${process.pid}-${aleatorioHex(4)}`;
  try { fs.renameSync(arquivoTrava, temporario); } catch { return false; } // outro já quebrou
  let ino = null;
  try { ino = fs.statSync(temporario, { bigint: true }).ino; } catch { /* ignora */ }
  if (ino !== null && ino !== infoVelha.ino) {
    // Pegou por engano a trava NOVA de outro processo: devolve (link falha se o nome já existir).
    try { fs.linkSync(temporario, arquivoTrava); } catch { /* ignora */ }
  }
  try { fs.unlinkSync(temporario); } catch { /* ignora */ }
  return true;
}

// Autoteste da 'exlock' (uma vez por processo): exige EBUSY na segunda abertura; se não vier, usa 'wx'.
let exlockConferida = null;
/** true = exclusiva; false = NÃO exclusiva (abriu duas vezes); null = inconclusivo (ex.: pasta não existe). */
function exlockExclusiva(pasta, flags = FLAGS_EXLOCK) {
  const teste = path.join(pasta, `.autoteste-exlock-${process.pid}-${aleatorioHex(3)}`);
  let fd1;
  let fd2;
  try { fd1 = fs.openSync(teste, flags); } catch { return null; }
  try {
    try { fd2 = fs.openSync(teste, flags); return false; } catch (e) { return e.code === 'EBUSY' ? true : null; }
  } finally {
    for (const fd of [fd2, fd1]) if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignora */ } }
    try { fs.unlinkSync(teste); } catch { /* ignora */ }
  }
}

function estrategiaEfetiva(op, arquivoTrava) {
  if (op.estrategia !== 'exlock') return op.estrategia;
  if (exlockConferida === null) {
    const r = exlockExclusiva(path.dirname(arquivoTrava));
    if (r === null) return 'exlock'; // inconclusivo: segue; o open de verdade mostra o erro real
    exlockConferida = r;
    if (!r) process.stderr.write(`[trava] AVISO: UV_FS_O_EXLOCK não é exclusiva no Node ${process.version}; usando 'wx'.\n`);
  }
  return exlockConferida ? 'exlock' : 'wx';
}

/** Adquire a trava de "alvo" (arquivo "<alvo>.lock" ou opcoes.arquivoTrava); devolve o objeto da trava. */
function adquirirTrava(alvo, opcoes = {}) {
  const op = { ...PADRAO_TRAVA, ...opcoes };
  const arquivoTrava = op.arquivoTrava || `${alvo}.lock`;
  op.estrategia = estrategiaEfetiva(op, arquivoTrava);
  const inicio = Date.now();
  let tentativas = 0;
  let ultimaChecagem = -Infinity; // a primeira falha já confere se a trava está velha
  for (;;) {
    tentativas++;
    try {
      if (op.estrategia === 'exlock') {
        const fd = fs.openSync(arquivoTrava, FLAGS_EXLOCK); // EBUSY se outro processo segura
        const trava = { estrategia: 'exlock', arquivoTrava, fd, tentativas };
        travasAbertas.add(trava);
        return trava;
      }
      const fd = fs.openSync(arquivoTrava, 'wx'); // EEXIST se já existe
      const token = aleatorioHex(8);
      let ino;
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: HOST, desde: Date.now(), token }));
        ino = fs.fstatSync(fd, { bigint: true }).ino;
      } finally {
        fs.closeSync(fd);
      }
      const trava = { estrategia: 'wx', arquivoTrava, ino, token, tentativas };
      travasAbertas.add(trava);
      return trava;
    } catch (e) {
      if (!CODIGOS_OCUPADO.has(e.code)) throw e; // ENOENT (pasta não existe) etc.: erro de verdade
      if (op.estrategia === 'wx' && Date.now() - ultimaChecagem >= op.checagemVelhaMs) {
        ultimaChecagem = Date.now();
        const info = lerTravaWx(arquivoTrava);
        if (info && travaWxVelha(info, op) && quebrarTravaWx(arquivoTrava, info)) continue;
      }
      if (Date.now() - inicio >= op.tempoMaximoMs) {
        const erro = new Error(`Tempo esgotado (${op.tempoMaximoMs} ms) esperando a trava ${barras(arquivoTrava)}`);
        erro.code = 'ETRAVA_TEMPO';
        throw erro;
      }
      aguardarVez(inicio, op.faseRapidaMs);
    }
  }
}

/** Libera a trava (na 'wx', só apaga o .lock se ainda for o mesmo arquivo que criamos). */
function liberarTrava(trava) {
  if (!trava || !travasAbertas.has(trava)) return false;
  travasAbertas.delete(trava);
  try {
    if (trava.estrategia === 'exlock') { fs.closeSync(trava.fd); return true; }
    if (fs.statSync(trava.arquivoTrava, { bigint: true }).ino !== trava.ino) return false; // foi quebrada
    fs.unlinkSync(trava.arquivoTrava);
    return true;
  } catch {
    return false;
  }
}

/** Executa fn() segurando a trava de "alvo" e sempre libera no fim; devolve o retorno de fn. */
function comTrava(alvo, fn, opcoes) {
  const trava = adquirirTrava(alvo, opcoes);
  try { return fn(trava); } finally { liberarTrava(trava); }
}

process.on('exit', () => { for (const t of [...travasAbertas]) liberarTrava(t); });

/**
 * Grava texto de forma atômica (temporário na mesma pasta + rename, com novas tentativas em EPERM/EBUSY).
 * sincronizar (padrão true): fsync do temporário antes do rename, para uma queda de energia não deixar o
 * arquivo novo vazio ou cheio de zeros. backup: copia o arquivo atual para <arquivo>.bak antes de trocar.
 */
function gravarAtomico(arquivo, conteudo, { tempoMaximoMs = 3000, sincronizar = true, backup = false } = {}) {
  const temporario = `${arquivo}.tmp-${process.pid}-${aleatorioHex(4)}`;
  const fd = fs.openSync(temporario, 'w');
  try {
    fs.writeSync(fd, conteudo);
    if (sincronizar) fs.fsyncSync(fd);
  } catch (e) {
    try { fs.closeSync(fd); } catch { /* ignora */ }
    try { fs.unlinkSync(temporario); } catch { /* ignora */ }
    throw e;
  }
  fs.closeSync(fd);
  if (backup) { try { fs.copyFileSync(arquivo, `${arquivo}.bak`); } catch { /* primeiro uso: não há o que copiar */ } }
  const inicio = Date.now();
  for (;;) {
    try { fs.renameSync(temporario, arquivo); return; } catch (e) {
      if (!CODIGOS_OCUPADO.has(e.code) || Date.now() - inicio >= tempoMaximoMs) {
        try { fs.unlinkSync(temporario); } catch { /* ignora */ }
        throw e;
      }
      aguardarVez(inicio, 50);
    }
  }
}

/** Grava um objeto como JSON indentado, de forma atômica (cria a pasta se faltar). */
function gravarJsonAtomico(arquivo, objeto, opcoes) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  gravarAtomico(arquivo, `${JSON.stringify(objeto, null, 2)}\n`, opcoes);
}

/** Lê um JSON (aceita BOM); devolve cópia de "padrao" se não existe; tenta de novo em EPERM/EBUSY; JSON inválido lança erro code 'EJSON'. */
function lerJson(arquivo, padrao = null, { tempoMaximoMs = 2000 } = {}) {
  const inicio = Date.now();
  for (;;) {
    let buf;
    try {
      buf = fs.readFileSync(arquivo);
    } catch (e) {
      if (e.code === 'ENOENT') return structuredClone(padrao);
      if (!CODIGOS_OCUPADO.has(e.code) || Date.now() - inicio >= tempoMaximoMs) throw e;
      aguardarVez(inicio, 50);
      continue;
    }
    try {
      return JSON.parse(decodificarTexto(buf));
    } catch (e) {
      const bak = `${arquivo}.bak`;
      const dica = fs.existsSync(bak)
        ? ` Para recuperar: confira ${barras(bak)} (a cópia da gravação anterior) e copie-o por cima de ${path.basename(arquivo)}, ou conserte o JSON à mão.`
        : ' Para recuperar: conserte o JSON à mão (ou restaure de um backup).';
      const erro = new Error(`${barras(arquivo)} não é um JSON válido (${e.message}); nada foi alterado.${dica} Não apague o arquivo: contadores e ids recomeçariam do zero.`);
      erro.code = 'EJSON';
      throw erro;
    }
  }
}

/** Apaga temporários órfãos (<nome>.tmp-<pid>-xxxx) com mais de "idadeMs" na pasta (sobras de processo morto). */
function limparTemporariosOrfaos(pasta, { idadeMs = 10 * 60e3 } = {}) {
  let nomes;
  try { nomes = fs.readdirSync(pasta); } catch { return 0; }
  let n = 0;
  const limite = Date.now() - idadeMs;
  for (const nome of nomes) {
    if (!/\.tmp-\d+-[0-9a-f]+$/.test(nome)) continue;
    const p = path.join(pasta, nome);
    try {
      if (fs.statSync(p).mtimeMs < limite) { fs.unlinkSync(p); n++; }
    } catch { /* outro processo já apagou ou está usando */ }
  }
  return n;
}

/**
 * Ler-alterar-gravar um JSON com trava. Aceita (arquivo, alterar, opcoes) ou (arquivo, inicial, alterar, opcoes).
 * "alterar" recebe o objeto atual (ou cópia de opcoes.inicial, se o arquivo não existe) e devolve o novo;
 * se devolver undefined, nada é gravado. opcoes: tempoMaximoMs (trava, leitura e gravação), arquivoTrava,
 * sincronizar (fsync, padrão true), backup (<arquivo>.bak, padrão false), limparTemporarios (padrão true),
 * recomecarSeCorrompido (padrão false: JSON inválido vira erro EJSON; true: renomeia para
 * <arquivo>.corrompido-AAAAMMDD-HHMMSS e recomeça de "inicial"; só para estado derivado, como sessões).
 */
function atualizarJson(arquivo, a, b, c) {
  let inicial = null;
  let alterar;
  let opcoes;
  if (typeof a === 'function') {
    alterar = a;
    opcoes = { ...(b || {}) };
    if (opcoes.inicial !== undefined) inicial = opcoes.inicial;
  } else {
    inicial = a;
    alterar = b;
    opcoes = { ...(c || {}) };
  }
  const { sincronizar = true, backup = false, limparTemporarios = true, recomecarSeCorrompido = false } = opcoes;
  for (const k of ['inicial', 'sincronizar', 'backup', 'limparTemporarios', 'recomecarSeCorrompido']) delete opcoes[k];
  const limite = opcoes.tempoMaximoMs !== undefined ? opcoes.tempoMaximoMs : PADRAO_TRAVA.tempoMaximoMs;
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  if (opcoes.arquivoTrava) fs.mkdirSync(path.dirname(opcoes.arquivoTrava), { recursive: true });
  return comTrava(arquivo, () => {
    if (limparTemporarios) limparTemporariosOrfaos(path.dirname(arquivo));
    let atual;
    try {
      atual = lerJson(arquivo, inicial, { tempoMaximoMs: Math.min(2000, limite) });
    } catch (e) {
      if (!(recomecarSeCorrompido && e.code === 'EJSON')) throw e;
      const c = carimbosSP();
      try { fs.renameSync(arquivo, `${arquivo}.corrompido-${c.compacto}-${c.hhmmss}`); } catch { /* segue mesmo assim */ }
      atual = structuredClone(inicial);
    }
    const novo = alterar(atual);
    if (novo === undefined) return atual;
    gravarJsonAtomico(arquivo, novo, { tempoMaximoMs: Math.min(3000, limite), sincronizar, backup });
    return novo;
  }, opcoes);
}

// =============================================================================================
// JSONL
// =============================================================================================

/** Acrescenta um objeto como uma linha JSONL (uma única chamada de escrita, sem trava; cria a pasta). */
function anexarJsonl(arquivo, objeto) {
  const linha = `${JSON.stringify(objeto)}\n`; // JSON.stringify nunca gera quebra de linha crua
  try {
    fs.appendFileSync(arquivo, linha, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    fs.mkdirSync(path.dirname(arquivo), { recursive: true }); // primeira linha do dia/mês
    fs.appendFileSync(arquivo, linha, 'utf8');
  }
}

/** Lê um .jsonl (ou .jsonl.gz) e devolve os objetos; linhas inválidas (ex.: a última pela metade) são ignoradas. */
function lerJsonl(arquivo) {
  let buf;
  const inicio = Date.now();
  for (;;) {
    try { buf = fs.readFileSync(arquivo); break; } catch (e) {
      if (e.code === 'ENOENT') return [];
      if (!CODIGOS_OCUPADO.has(e.code) || Date.now() - inicio >= 2000) throw e;
      aguardarVez(inicio, 50);
    }
  }
  if (arquivo.endsWith('.gz')) buf = zlib().gunzipSync(buf);
  const saida = [];
  for (const linha of buf.toString('utf8').split('\n')) {
    const t = linha.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object' && !Array.isArray(o)) saida.push(o);
    } catch { /* linha pela metade ou corrompida: ignora */ }
  }
  return saida;
}

/** Lista os .jsonl e .jsonl.gz de uma pasta, em ordem de nome; pasta inexistente devolve []. */
function listarJsonl(pasta) {
  try {
    return fs.readdirSync(pasta).filter((n) => /\.jsonl(\.gz)?$/.test(n)).sort().map((n) => path.join(pasta, n));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

/** Ordena objetos pelo campo ts (data ISO), mantendo a ordem original nos empates. */
function ordenarPorTs(lista) {
  return lista
    .map((o, i) => [o, Date.parse(o && o.ts), i])
    .sort((x, y) => ((Number.isNaN(x[1]) ? 0 : x[1]) - (Number.isNaN(y[1]) ? 0 : y[1])) || (x[2] - y[2]))
    .map((x) => x[0]);
}

// =============================================================================================
// Entrada padrão e decodificação de texto
// =============================================================================================

/** Decodifica bytes de texto: UTF-8 (com ou sem BOM) ou UTF-16 com BOM (arquivos do PowerShell 5). */
function decodificarTexto(buf) {
  if (typeof buf === 'string') return buf.replace(/^﻿/, '');
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const c = Buffer.from(buf.subarray(2, 2 + Math.floor((buf.length - 2) / 2) * 2));
    c.swap16();
    return c.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}

/** true se a entrada padrão é um terminal interativo (sem pipe nem redirecionamento). */
function stdinInterativo() {
  try { return require('tty').isatty(0); } catch { return false; }
}

/** Lê toda a entrada padrão de forma síncrona e devolve um Buffer (vazio se não houver nada). */
function lerStdinSync() {
  const partes = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    let n;
    try {
      n = fs.readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if (e.code === 'EAGAIN') { dormir(5); continue; }
      if (e.code === 'EOF') break; // Windows: pipe fechado
      throw e;
    }
    if (n === 0) break;
    partes.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(partes);
}

// =============================================================================================
// Redação de segredos e truncamento
// =============================================================================================

const MARCA_REDIGIDO = '«redigido»';
const PALAVRAS_SEGREDO = String.raw`(?:password|passwd|passphrase|senha|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|token|secret|segredo)`;
// As aspas podem vir escapadas (\" ou \\\") quando o texto é JSON dentro de JSON ou um comando com echo "{\"...\"}".
const CHAVE_SEGREDO = String.raw`(\b[\w.-]*?` + PALAVRAS_SEGREDO + String.raw`\b(?:\\*["'])?\s*[:=]\s*)`;
const CHAVE_AUTH = String.raw`(\bauthorization\b(?:\\*["'])?\s*[:=]\s*)`;
const VALOR_ESCAPADO = String.raw`(\\+)"[^"\r\n]*?\\+"`; // \"valor\" (aspas escapadas)
const RE_AUTH_ESCAPADO = new RegExp(CHAVE_AUTH + VALOR_ESCAPADO, 'gi');
const RE_AUTH_DUPLAS = new RegExp(CHAVE_AUTH + String.raw`"(?:\\.|[^"\\\r\n])*"`, 'gi');
const RE_AUTH_SIMPLES = new RegExp(CHAVE_AUTH + String.raw`'(?:\\.|[^'\\\r\n])*'`, 'gi');
const RE_AUTH_LIVRE = new RegExp(CHAVE_AUTH + String.raw`(?!\\*["'«])[^\r\n"'\\]+`, 'gi');
const RE_BEARER = /\b(Bearer)\s+(?!«)[A-Za-z0-9._~+/=-]+/gi;
const RE_KV_ESCAPADO = new RegExp(CHAVE_SEGREDO + VALOR_ESCAPADO, 'gi');
const RE_KV_DUPLAS = new RegExp(CHAVE_SEGREDO + String.raw`"(?:\\.|[^"\\\r\n])*"`, 'gi');
const RE_KV_SIMPLES = new RegExp(CHAVE_SEGREDO + String.raw`'(?:\\.|[^'\\\r\n])*'`, 'gi');
const RE_KV_LIVRE = new RegExp(CHAVE_SEGREDO + String.raw`(?!\\*["'«])[^\s"'&,;)}\]\\]+`, 'gi');
const RE_FLAG_SEGREDO = new RegExp(String.raw`(--?[\w-]*?` + PALAVRAS_SEGREDO + String.raw`)(\s+)("[^"\r\n]*"|'[^'\r\n]*'|(?![-<>|«])\S+)`, 'gi');
// Credencial embutida em URL: esquema://usuario:senha@host.
const RE_URL_CREDENCIAL = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/"'\\]+:)[^\s@/"'\\]+@/gi;
// Senha colada na flag curta do cliente MySQL/MariaDB: mysql -u root -pS3nha (o -P maiúsculo é a porta).
const RE_MYSQL_P = /(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\r\n|;&]*?\s-p)(?=[^\s-])\S+/g;
const RE_HEX_LONGO = /\b[0-9a-fA-F]{32,}\b/g;
const RE_BASE64_LONGO = /[A-Za-z0-9+/_-]{40,}={0,2}/g;
// Pedaço "legível" de caminho, slug ou identificador: curto, palavra (minúsculas, Capitalizada, CamelCase,
// SIGLA), número ou hex. Um pedaço aleatório de base64 com 9+ caracteres quase nunca casa com isto.
const RE_PEDACO_LEGIVEL = /^(?:[A-Za-z0-9]{0,8}|\d+|[0-9a-f]+|[0-9A-F]+|(?:[A-Z]+|[A-Z]?[a-z]+)(?:[A-Z][a-z]+)*[A-Z]*\d*)$/;
const RE_NOME_VAR_SEGREDO = /(TOKEN|SECRET|PASSWORD|PASSWD|SENHA|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;
const RE_NOME_VAR_NAO_SEGREDO = /(_PATH|_FILE|_DIR|_URL|_SOCKET|_HOST|_PORT)$/i;

/** Valores de variáveis de ambiente com nome de segredo (inclui CLAUDE_CODE_MESSAGING_TOKEN), do maior para o menor. */
function segredosDoAmbiente(env = process.env) {
  const valores = [];
  for (const [nome, valor] of Object.entries(env || {})) {
    if (typeof valor !== 'string' || valor.length < 8) continue;
    if (nome === 'CLAUDE_CODE_MESSAGING_TOKEN' || (RE_NOME_VAR_SEGREDO.test(nome) && !RE_NOME_VAR_NAO_SEGREDO.test(nome))) valores.push(valor);
  }
  return valores.sort((x, y) => y.length - x.length);
}

/**
 * Heurística para uma sequência base64/base64url de 40+ caracteres, avaliada INTEIRA: é segredo se mistura
 * pelo menos 2 classes (minúscula, maiúscula, dígito) e algum pedaço entre - _ / + não é legível (caminho,
 * slug, CamelCase, uuid). Com '+' e as 3 classes, é segredo sempre (caminhos quase nunca têm '+').
 */
function pareceSegredo(trecho) {
  const s = trecho.replace(/=+$/, '');
  const classes = Number(/[a-z]/.test(s)) + Number(/[A-Z]/.test(s)) + Number(/\d/.test(s));
  if (classes < 2) return false;
  if (classes === 3 && s.includes('+')) return true;
  return s.split(/[-_/+]/).some((p) => !RE_PEDACO_LEGIVEL.test(p));
}

/** Troca segredos por «redigido»: Authorization, Bearer, chave=valor (token, password, senha, api key...; também com aspas escapadas), --flag de segredo, usuario:senha@ em URL, mysql -pSENHA, hex >= 32, base64 >= 40 e valores do ambiente. */
function redigir(texto, { env = process.env } = {}) {
  if (texto === undefined || texto === null) return texto;
  let s = String(texto);
  for (const v of segredosDoAmbiente(env)) if (s.includes(v)) s = s.split(v).join(MARCA_REDIGIDO);
  return s
    .replace(RE_URL_CREDENCIAL, `$1${MARCA_REDIGIDO}@`)
    .replace(RE_MYSQL_P, `$1${MARCA_REDIGIDO}`)
    .replace(RE_AUTH_ESCAPADO, `$1$2"${MARCA_REDIGIDO}$2"`)
    .replace(RE_AUTH_DUPLAS, `$1"${MARCA_REDIGIDO}"`)
    .replace(RE_AUTH_SIMPLES, `$1'${MARCA_REDIGIDO}'`)
    .replace(RE_AUTH_LIVRE, `$1${MARCA_REDIGIDO}`)
    .replace(RE_BEARER, `$1 ${MARCA_REDIGIDO}`)
    .replace(RE_KV_ESCAPADO, `$1$2"${MARCA_REDIGIDO}$2"`)
    .replace(RE_KV_DUPLAS, `$1"${MARCA_REDIGIDO}"`)
    .replace(RE_KV_SIMPLES, `$1'${MARCA_REDIGIDO}'`)
    .replace(RE_KV_LIVRE, `$1${MARCA_REDIGIDO}`)
    .replace(RE_FLAG_SEGREDO, `$1$2${MARCA_REDIGIDO}`)
    .replace(RE_HEX_LONGO, MARCA_REDIGIDO)
    .replace(RE_BASE64_LONGO, (m) => (pareceSegredo(m) ? MARCA_REDIGIDO : m));
}

// Chave de objeto cujo valor é segredo (access_token, apiKey, password, Authorization...), mas não max_tokens.
const RE_CHAVE_OBJETO_SEGREDO = new RegExp(String.raw`^[\w.-]*?(?:` + PALAVRAS_SEGREDO.slice(3, -1) + String.raw`|authorization|cookie|credentials?)$`, 'i');

/**
 * Redige um valor JSON qualquer ANTES de serializar: troca por «redigido» o valor das chaves de segredo e
 * aplica redigir() em cada texto (assim o JSON embutido num texto aparece cru, com aspas normais).
 * Para economizar, corta cada texto em "maxTexto" e para de descer depois de "orcamento" caracteres.
 */
function redigirValor(valor, { env = process.env, maxTexto = 1600, orcamento = 4000, profundidade = 8 } = {}) {
  const conta = { resta: orcamento };
  const andar = (v, nivel) => {
    if (conta.resta <= 0) return '…';
    if (typeof v === 'string') {
      const cortado = v.length > maxTexto ? v.slice(0, maxTexto) : v;
      conta.resta -= cortado.length;
      return redigir(cortado, { env });
    }
    if (v === null || typeof v !== 'object') { conta.resta -= 8; return v; }
    if (nivel >= profundidade) return '…';
    if (Array.isArray(v)) {
      const r = [];
      for (const x of v) {
        if (conta.resta <= 0) { r.push('…'); break; }
        r.push(andar(x, nivel + 1));
      }
      return r;
    }
    const r = {};
    for (const [k, x] of Object.entries(v)) {
      if (conta.resta <= 0) { r['…'] = '…'; break; }
      conta.resta -= k.length;
      r[k] = (RE_CHAVE_OBJETO_SEGREDO.test(k) && (typeof x === 'string' || typeof x === 'number') && x !== '') ? MARCA_REDIGIDO : andar(x, nivel + 1);
    }
    return r;
  };
  return andar(valor, 0);
}

/** Corta o texto em no máximo "max" caracteres, terminando em "…[+N]" quando corta (sem partir emoji). */
function truncar(texto, max, { total } = {}) {
  if (texto === undefined || texto === null) return texto;
  const s = String(texto);
  const tamanho = total !== undefined ? total : s.length;
  if (!(max > 0) || (s.length <= max && tamanho <= s.length)) return s;
  let corte = Math.min(s.length, max - `…[+${tamanho}]`.length);
  if (corte <= 0) return s.slice(0, max);
  const cc = s.charCodeAt(corte - 1);
  if (cc >= 0xd800 && cc <= 0xdbff) corte--; // não deixa meio par substituto (emoji)
  return `${s.slice(0, corte)}…[+${tamanho - corte}]`;
}

/** Redige e trunca (redige antes de cortar, para não deixar meio segredo passar); textos enormes são pré-cortados. */
function resumir(texto, max, opcoes) {
  if (texto === undefined || texto === null) return texto;
  const s = String(texto);
  const limitePrevio = max * 4 + 400;
  const preCortado = s.length > limitePrevio;
  const r = redigir(preCortado ? s.slice(0, limitePrevio) : s, opcoes);
  if (!preCortado) return truncar(r, max);
  return truncar(r, max, { total: r.length + (s.length - limitePrevio) });
}

// =============================================================================================
// Agentes e identificação (decisão 5)
// =============================================================================================

/** Lê registro/agentes.json ({workspace, padrao, agentes}); lança erro se não existir ou for inválido. */
function carregarAgentes({ tempoMaximoMs = 2000 } = {}) {
  const c = lerJson(caminhos().agentes, null, { tempoMaximoMs });
  if (!c || typeof c !== 'object' || Array.isArray(c)) {
    const e = new Error(`registro/agentes.json não encontrado em ${barras(dirMaestro())}`);
    e.code = 'ENOENT';
    throw e;
  }
  if (!Array.isArray(c.agentes)) c.agentes = [];
  return c;
}

/** Como carregarAgentes, mas devolve null em vez de lançar erro. */
function carregarAgentesSeguro(opcoes) {
  try { return carregarAgentes(opcoes); } catch { return null; }
}

/** Nome da última pasta de um caminho (para "desconhecido:<pasta>"). */
function nomeDaPasta(p) {
  const n = normalizarCaminho(p) ? path.basename(String(p).replace(/[\\/]+$/, '')) : '';
  return (n && n.replace(/\s+/g, ' ').trim()) || 'sem-pasta';
}

/** Agente cujo diretório contém o caminho (o diretório mais específico vence), ou null. */
function agentePorDiretorio(agentes, caminho) {
  let melhor = null;
  let tamanho = -1;
  for (const a of agentes) {
    if (!a || typeof a.slug !== 'string' || !Array.isArray(a.diretorios)) continue;
    for (const d of a.diretorios) {
      if (typeof d !== 'string' || !d.trim() || !dentroDe(caminho, d)) continue;
      const n = normalizarCaminho(d).length;
      if (n > tamanho) { melhor = a; tamanho = n; }
    }
  }
  return melhor;
}

/**
 * Identifica o agente (decisão 5). Devolve {nosso, motivo, agente, terminal, workspace, conhecido}.
 * nosso=false: MAESTRI_WORKSPACE_ID de outro workspace, ou sem MAESTRI_WORKSPACE_ID e fora da raiz.
 * agente: terminal_id === MAESTRI_TERMINAL_ID; senão por diretório (cwd, depois CLAUDE_PROJECT_DIR);
 * senão "desconhecido:" + 8 primeiros do terminal (ou nome da pasta do cwd).
 */
function identificarAgente({ env = process.env, cwd = process.cwd(), cadastro } = {}) {
  if (cadastro === undefined) cadastro = carregarAgentesSeguro();
  const workspace = env.MAESTRI_WORKSPACE_ID || null;
  const terminal = env.MAESTRI_TERMINAL_ID || null;
  const candidatos = [cwd, env.CLAUDE_PROJECT_DIR].filter((x) => typeof x === 'string' && x.trim());
  const ws = cadastro && cadastro.workspace ? cadastro.workspace : {};
  const raiz = (typeof ws.raiz === 'string' && ws.raiz.trim()) ? ws.raiz : raizPadrao();
  const naRaiz = candidatos.some((d) => dentroDe(d, raiz));
  let nosso = true;
  let motivo = null;
  if (workspace) {
    if (ws.id) {
      if (workspace !== ws.id) { nosso = false; motivo = 'outro-workspace'; }
    } else if (!naRaiz) { nosso = false; motivo = 'workspace-nao-confirmado'; }
  } else if (!naRaiz) { nosso = false; motivo = 'fora-da-raiz'; }
  const lista = cadastro && Array.isArray(cadastro.agentes) ? cadastro.agentes : [];
  let achado = terminal ? lista.find((a) => a && a.terminal_id && a.terminal_id === terminal) : null;
  for (const c of candidatos) { if (!achado) achado = agentePorDiretorio(lista, c); }
  const agente = achado ? achado.slug : `desconhecido:${terminal ? terminal.slice(0, 8) : nomeDaPasta(cwd)}`;
  return { nosso, motivo, agente, terminal, workspace, conhecido: !!achado };
}

// =============================================================================================
// Eventos do log semântico (§10.3)
// =============================================================================================

const ORIGENS_FIXAS = ['dono-direto', 'cerebro', 'rotina', 'sistema'];
const TIPOS_EVENTO = ['pedido-recebido', 'delegacao', 'resposta-recebida', 'aviso', 'consulta', 'execucao', 'auditoria',
  'relatorio', 'decisao', 'pendencia-aberta', 'pendencia-resolvida', 'bloqueio', 'erro', 'manutencao', 'bootstrap'];
const RESULTADOS = ['ok', 'parcial', 'falhou', 'bloqueado', 'aguardando-dono', 'em-andamento'];
const TIPOS_COM_DIRECAO = ['decisao', 'execucao', 'delegacao', 'auditoria'];
const OBRIGATORIOS_EVENTO = ['agente', 'fluxo_id', 'origem', 'tipo', 'resumo', 'resultado'];
const CAMPOS_EVENTO = ['id', 'ts', 'agente', 'fluxo_id', 'origem', 'tipo', 'projeto', 'trello', 'resumo', 'direcao', 'passos',
  'comandos', 'alteracoes', 'resultado', 'validacao', 'proximo_passo', 'precisa_dono', 'pendencias', 'duracao_s', 'sessao',
  'teste', 'tipo_original', 'importado_de'];
const CAMPOS_TRELLO = ['shortLink', 'titulo', 'url', 'status_antes', 'status_depois'];
const CAMPOS_TEXTO_LIVRE = ['resumo', 'direcao', 'validacao', 'proximo_passo'];
const CAMPOS_LISTA_LIVRE = ['passos', 'comandos', 'alteracoes'];
const MAX_RESUMO = 100;
const RE_FLUXO = /^F-\d{8}-\d{4}$/;
const RE_FLUXO_NO_TEXTO = /(?<![\w-])F-\d{8}-\d{4}(?!\d)/g;
const RE_PENDENCIA = /^P-\d{4,}$/;
const RE_ID_EVENTO = /^EV-\d{8}-\d{6}-[0-9a-f]{4}$/;
const RE_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const RE_DESCONHECIDO = /^desconhecido:\S.*$/;

/** Normaliza um valor de lista fechada: sem acentos, minúsculas, sem espaços nas pontas ("Execução" vira "execucao"). */
function normalizarEnum(v) {
  return typeof v === 'string' ? tirarAcentos(v).trim().toLowerCase() : v;
}

/** true se for texto com algum caractere visível. */
function textoPreenchido(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/** Problemas de um slug de agente (formato e, se houver cadastro, presença em agentes.json). */
function problemasDoAgente(slug, cadastro, rotulo = 'agente') {
  if (RE_DESCONHECIDO.test(slug)) return [];
  if (!RE_SLUG.test(slug)) return [`${rotulo} "${slug}" inválido: use o slug do agente (minúsculas, números e hífen), ex.: cerebro`];
  const lista = cadastro && Array.isArray(cadastro.agentes) ? cadastro.agentes.filter((a) => a && a.slug) : [];
  if (lista.length && !lista.some((a) => a.slug === slug)) {
    return [`${rotulo} "${slug}" não está em registro/agentes.json (conhecidos: ${lista.map((a) => a.slug).join(', ')})`];
  }
  return [];
}

/** Problemas da origem: dono-direto, cerebro, rotina, sistema ou agente:<slug>. */
function problemasDaOrigem(origem, cadastro) {
  if (ORIGENS_FIXAS.includes(origem)) return [];
  const m = /^agente:(.+)$/.exec(origem);
  if (m) return problemasDoAgente(m[1], cadastro, 'origem: agente');
  return [`origem "${origem}" não é permitida (use: ${ORIGENS_FIXAS.join(', ')} ou agente:<slug>)`];
}

/** Valida um evento (§10.3); devolve a lista de problemas em português (vazia = válido). */
function validarEvento(ev, { cadastro } = {}) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return ['o evento precisa ser um objeto JSON'];
  const p = [];
  for (const k of Object.keys(ev)) {
    if (!CAMPOS_EVENTO.includes(k)) p.push(`campo desconhecido "${k}" (aceitos: ${CAMPOS_EVENTO.join(', ')})`);
  }
  for (const k of OBRIGATORIOS_EVENTO) if (!textoPreenchido(ev[k])) p.push(`falta o campo obrigatório "${k}"`);
  if (textoPreenchido(ev.agente)) p.push(...problemasDoAgente(ev.agente, cadastro));
  if (textoPreenchido(ev.fluxo_id) && !RE_FLUXO.test(ev.fluxo_id)) p.push(`fluxo_id "${ev.fluxo_id}" inválido: use o formato F-AAAAMMDD-NNNN`);
  if (textoPreenchido(ev.origem)) p.push(...problemasDaOrigem(ev.origem, cadastro));
  if (textoPreenchido(ev.tipo) && !TIPOS_EVENTO.includes(ev.tipo)) p.push(`tipo "${ev.tipo}" não é permitido (use: ${TIPOS_EVENTO.join(', ')})`);
  if (textoPreenchido(ev.resultado) && !RESULTADOS.includes(ev.resultado)) p.push(`resultado "${ev.resultado}" não é permitido (use: ${RESULTADOS.join(', ')})`);
  if (typeof ev.resumo === 'string') {
    const n = [...ev.resumo].length;
    if (n > MAX_RESUMO) p.push(`"resumo" tem ${n} caracteres; o máximo é ${MAX_RESUMO}`);
    if (/[\r\n]/.test(ev.resumo)) p.push('"resumo" deve ter uma linha só');
  }
  if (TIPOS_COM_DIRECAO.includes(ev.tipo) && !textoPreenchido(ev.direcao)) {
    p.push(`"direcao" é obrigatória quando o tipo é ${ev.tipo} (diga o caminho escolhido e o porquê)`);
  }
  for (const k of ['agente', 'fluxo_id', 'origem', 'tipo', 'resumo', 'resultado', 'projeto', 'direcao', 'validacao',
    'proximo_passo', 'sessao', 'tipo_original', 'importado_de']) {
    if (ev[k] !== undefined && typeof ev[k] !== 'string') p.push(`"${k}" deve ser texto`);
  }
  for (const k of [...CAMPOS_LISTA_LIVRE, 'pendencias']) {
    if (ev[k] !== undefined && (!Array.isArray(ev[k]) || ev[k].some((x) => typeof x !== 'string'))) p.push(`"${k}" deve ser uma lista de textos`);
  }
  if (Array.isArray(ev.pendencias)) {
    for (const x of ev.pendencias) if (typeof x === 'string' && !RE_PENDENCIA.test(x)) p.push(`pendência "${x}" inválida: use o formato P-NNNN`);
  }
  if (ev.precisa_dono !== undefined && typeof ev.precisa_dono !== 'boolean') p.push('"precisa_dono" deve ser true ou false');
  if (ev.teste !== undefined && typeof ev.teste !== 'boolean') p.push('"teste" deve ser true ou false');
  if (ev.duracao_s !== undefined && !(typeof ev.duracao_s === 'number' && Number.isFinite(ev.duracao_s) && ev.duracao_s >= 0)) {
    p.push('"duracao_s" deve ser um número de segundos maior ou igual a zero');
  }
  if (ev.trello !== undefined) {
    if (!ev.trello || typeof ev.trello !== 'object' || Array.isArray(ev.trello)) p.push(`"trello" deve ser um objeto com ${CAMPOS_TRELLO.join(', ')}`);
    else {
      for (const [k, v] of Object.entries(ev.trello)) {
        if (!CAMPOS_TRELLO.includes(k)) p.push(`campo desconhecido "trello.${k}" (aceitos: ${CAMPOS_TRELLO.join(', ')})`);
        else if (typeof v !== 'string') p.push(`"trello.${k}" deve ser texto`);
      }
      p.push(...problemasDoTrello(ev.trello));
    }
  }
  if (ev.ts !== undefined && !lerData(ev.ts)) p.push(`ts "${ev.ts}" inválido: use ISO 8601 com fuso, ex.: 2026-10-08T15:42:10-03:00`);
  if (ev.id !== undefined && !(typeof ev.id === 'string' && RE_ID_EVENTO.test(ev.id))) p.push(`id "${ev.id}" inválido: use EV-AAAAMMDD-HHMMSS-xxxx`);
  return p;
}

/** Gera o id EV-AAAAMMDD-HHMMSS-xxxx (xxxx de um hash de pid, relógio fino e acaso; com "semente", derivado só dela, para importações idempotentes). */
function gerarIdEvento(data = agora(), semente) {
  const c = carimbosSP(data);
  const base = semente === undefined
    ? `${process.pid}|${process.hrtime.bigint()}|${Math.random()}|${aleatorioHex(8)}`
    : String(semente);
  const sufixo = cripto().createHash('sha1').update(base).digest('hex').slice(0, 4);
  return `EV-${c.compacto}-${c.hhmmss}-${sufixo}`;
}

/** true se o id já aparece no fim (últimos ~64 KB) do arquivo de eventos (colisão de sufixo no mesmo segundo). */
function idJaUsado(arquivo, id) {
  let fd;
  try { fd = fs.openSync(arquivo, 'r'); } catch { return false; }
  try {
    const tamanho = fs.fstatSync(fd).size;
    const n = Math.min(tamanho, 64 * 1024);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, tamanho - n);
    return buf.toString('utf8').includes(`"id":"${id}"`);
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/** Completa o bloco trello: url a partir do shortLink e shortLink a partir da url. */
function completarTrello(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return t;
  const r = { ...t };
  if (textoPreenchido(r.shortLink) && !textoPreenchido(r.url)) r.url = `https://trello.com/c/${r.shortLink.trim()}`;
  if (!textoPreenchido(r.shortLink) && textoPreenchido(r.url)) {
    const m = /trello\.com\/c\/([A-Za-z0-9]+)/.exec(r.url);
    if (m) r.shortLink = m[1];
  }
  return r;
}

const RE_SHORTLINK = /^[A-Za-z0-9]{6,12}$/;
const RE_URL_CARTAO = /trello\.com\/c\/([A-Za-z0-9]{6,12})(?![A-Za-z0-9])/;

/** Interpreta "shortLink" ou URL de cartão do Trello em {shortLink, url}; qualquer outro texto (ex.: URL do quadro) é erro de uso. */
function trelloDeTexto(texto) {
  const s = String(texto || '').trim();
  if (!s) return undefined;
  const m = RE_URL_CARTAO.exec(s);
  if (m) return { shortLink: m[1], url: s };
  if (RE_SHORTLINK.test(s)) return completarTrello({ shortLink: s });
  throw erroArgs(`Trello "${s}" não é um cartão: passe o shortLink do cartão (ex.: AbCd1234) ou a URL https://trello.com/c/<shortLink>/... (a URL do quadro, /b/..., não serve)`);
}

/** Problemas do bloco trello de um evento ou pendência (shortLink com formato de cartão, url de cartão). */
function problemasDoTrello(t, rotulo = 'trello') {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return [];
  const p = [];
  if (typeof t.shortLink === 'string' && t.shortLink.trim() && !RE_SHORTLINK.test(t.shortLink.trim())) {
    p.push(`"${rotulo}.shortLink" "${t.shortLink}" inválido: use o shortLink do cartão (6 a 12 letras e números, ex.: AbCd1234)`);
  }
  if (typeof t.url === 'string' && t.url.trim() && /trello\.com\//i.test(t.url) && !RE_URL_CARTAO.test(t.url)) {
    p.push(`"${rotulo}.url" "${t.url}" não é a URL de um cartão (use https://trello.com/c/<shortLink>)`);
  }
  return p;
}

/** Põe os campos do evento na ordem do schema e tira os vazios (undefined). */
function ordenarCampos(ev) {
  const r = {};
  for (const k of CAMPOS_EVENTO) if (ev[k] !== undefined) r[k] = ev[k];
  for (const k of Object.keys(ev)) if (!(k in r) && ev[k] !== undefined) r[k] = ev[k];
  return r;
}

/**
 * Prepara um evento: normaliza enums, completa ts/sessao/precisa_dono/trello, redige textos livres e valida.
 * opcoes: agora, env (para sessao e redação), cadastro (agentes.json), semente (id determinístico).
 * Devolve {evento, problemas}; evento é null quando há problemas.
 */
function montarEvento(dados, { agora: quando, env = process.env, cadastro, semente } = {}) {
  if (!dados || typeof dados !== 'object' || Array.isArray(dados)) return { evento: null, problemas: ['o evento precisa ser um objeto JSON'] };
  if (cadastro === undefined) cadastro = carregarAgentesSeguro();
  const ev = { ...dados };
  const problemas = [];
  if (ev.id !== undefined) { problemas.push('o campo "id" é gerado pelo registrar; tire-o do evento'); delete ev.id; }
  for (const k of ['origem', 'tipo', 'resultado', 'tipo_original']) if (typeof ev[k] === 'string') ev[k] = normalizarEnum(ev[k]);
  for (const k of ['agente', 'fluxo_id', 'projeto']) if (typeof ev[k] === 'string') ev[k] = ev[k].trim();
  if (typeof ev.fluxo_id === 'string') ev.fluxo_id = ev.fluxo_id.toUpperCase();
  let data;
  if (ev.ts !== undefined) {
    data = lerData(ev.ts);
    if (data) ev.ts = isoSP(data);
  } else {
    data = quando || agora();
    ev.ts = isoSP(data);
  }
  if (ev.sessao === undefined && env && env.CLAUDE_CODE_SESSION_ID) ev.sessao = String(env.CLAUDE_CODE_SESSION_ID);
  if (ev.precisa_dono === undefined) ev.precisa_dono = false;
  if (ev.trello !== undefined) ev.trello = completarTrello(ev.trello);
  // Redação: nunca gravar segredo, nem por descuido.
  const red = (v) => (typeof v === 'string' ? redigir(v, { env }) : v);
  for (const k of CAMPOS_TEXTO_LIVRE) ev[k] = red(ev[k]);
  for (const k of CAMPOS_LISTA_LIVRE) if (Array.isArray(ev[k])) ev[k] = ev[k].map(red);
  if (ev.trello && typeof ev.trello === 'object') for (const k of ['titulo', 'url']) ev.trello[k] = red(ev.trello[k]);
  if (ev.trello && typeof ev.trello === 'object') for (const k of Object.keys(ev.trello)) if (ev.trello[k] === undefined) delete ev.trello[k];
  problemas.push(...validarEvento(ev, { cadastro }));
  if (problemas.length) return { evento: null, problemas };
  const evento = ordenarCampos({ ...ev, id: gerarIdEvento(data, semente) });
  return { evento, problemas: [] };
}

/**
 * Grava um evento já validado em logs/eventos/AAAA-MM.jsonl (mês do ts em São Paulo). Se o id já existir no
 * fim do arquivo (colisão do sufixo de 16 bits no mesmo segundo), troca o sufixo antes de gravar.
 */
function gravarEvento(evento) {
  const data = lerData(evento.ts) || agora();
  const arquivo = arquivoEventos(data);
  for (let i = 1; i <= 20 && evento.id && idJaUsado(arquivo, evento.id); i++) {
    evento.id = gerarIdEvento(data, `${evento.id}|${i}|${process.pid}|${Math.random()}`);
  }
  anexarJsonl(arquivo, evento);
  return arquivo;
}

/** Cria um erro de validação (code 'EVALIDACAO') com a lista de problemas. */
function erroValidacao(problemas, titulo = 'Evento inválido') {
  const e = new Error(`${titulo} (${problemas.length} ${problemas.length === 1 ? 'problema' : 'problemas'}):`);
  e.code = 'EVALIDACAO';
  e.problemas = problemas;
  return e;
}

/** Monta, valida e grava um evento; devolve o evento gravado ou lança erro 'EVALIDACAO'. */
function registrarEvento(dados, opcoes) {
  const { evento, problemas } = montarEvento(dados, opcoes);
  if (problemas.length) throw erroValidacao(problemas);
  gravarEvento(evento);
  return evento;
}

/** Lê os eventos de todos os meses (ou só dos meses entre "desde" e "ate"), em ordem de ts. */
function lerEventos({ desde, ate } = {}) {
  const mesIni = desde ? carimbosSP(desde).aaaamm : null;
  const mesFim = ate ? carimbosSP(ate).aaaamm : null;
  const todos = [];
  for (const arq of listarJsonl(caminhos().eventos)) {
    const mes = path.basename(arq).slice(0, 7);
    if (mesIni && mes < mesIni) continue;
    if (mesFim && mes > mesFim) continue;
    todos.push(...lerJsonl(arq));
  }
  return ordenarPorTs(todos);
}

// =============================================================================================
// Sessões e fluxos (decisão 8)
// =============================================================================================

/** Estado da sessão (estado/sessoes/<id>.json) ou null; nunca lança erro. */
function sessaoAtual(sessionId, { tempoMaximoMs = 500 } = {}) {
  if (!idSessaoSeguro(sessionId)) return null;
  try {
    const s = lerJson(arquivoSessao(sessionId), null, { tempoMaximoMs });
    return s && typeof s === 'object' ? s : null;
  } catch {
    return null;
  }
}

/** fluxo_id atual da sessão, ou null. */
function fluxoDaSessao(sessionId, opcoes) {
  const s = sessaoAtual(sessionId, opcoes);
  return s && typeof s.fluxo_id === 'string' && RE_FLUXO.test(s.fluxo_id) ? s.fluxo_id : null;
}

/**
 * Ler-alterar-gravar o arquivo da sessão com a trava compartilhada estado/sessoes.lock. A sessão é estado
 * derivado: se o arquivo estiver corrompido, ele é posto de lado (.corrompido-...) e recomeça do zero.
 */
function atualizarSessao(sessionId, alterar, opcoes = {}) {
  return atualizarJson(arquivoSessao(sessionId), alterar, {
    inicial: null, arquivoTrava: caminhos().travaSessoes, recomecarSeCorrompido: true, ...opcoes,
  });
}

/**
 * Diagnóstico do fluxo da sessão, para mensagens de erro claras:
 * {estado: 'sem-id'|'sem-arquivo'|'ilegivel'|'sem-fluxo'|'ok', fluxo, arquivo}.
 */
function diagnosticoSessao(sessionId) {
  if (!idSessaoSeguro(sessionId)) return { estado: 'sem-id', fluxo: null, arquivo: null };
  const arquivo = arquivoSessao(sessionId);
  let s;
  const AUSENTE = '«arquivo-ausente»';
  try { s = lerJson(arquivo, AUSENTE, { tempoMaximoMs: 500 }); } catch { return { estado: 'ilegivel', fluxo: null, arquivo }; }
  if (s === AUSENTE) return { estado: 'sem-arquivo', fluxo: null, arquivo };
  const fluxo = s && typeof s.fluxo_id === 'string' && RE_FLUXO.test(s.fluxo_id) ? s.fluxo_id : null;
  return { estado: fluxo ? 'ok' : 'sem-fluxo', fluxo, arquivo };
}

/** Mensagem de "falta o fluxo" conforme o diagnóstico da sessão (CLAUDE_CODE_SESSION_ID). */
function mensagemSemFluxo(sessionId) {
  const d = diagnosticoSessao(sessionId);
  const base = 'falta o fluxo: passe --fluxo F-AAAAMMDD-NNNN';
  if (d.estado === 'sem-id') return `${base} (não há CLAUDE_CODE_SESSION_ID: este comando não está rodando numa sessão do Claude Code)`;
  if (d.estado === 'sem-arquivo') return `${base} (o hook não registrou esta sessão em estado/sessoes/; confira com "node ${barras(path.join(__dirname, 'instalar-hooks.js'))} --verificar")`;
  if (d.estado === 'ilegivel') return `${base} (o arquivo da sessão ${barras(d.arquivo)} está ilegível; o hook o recria no próximo prompt)`;
  return `${base} (a sessão atual não tem fluxo: o prompt não trazia um id F-... e ninguém rodou "registrar novo-fluxo" nela)`;
}

/** Último id F-AAAAMMDD-NNNN que aparece num texto, ou null. */
function ultimoFluxoNoTexto(texto) {
  if (typeof texto !== 'string') return null;
  const achados = texto.match(RE_FLUXO_NO_TEXTO);
  return achados ? achados[achados.length - 1] : null;
}

// =============================================================================================
// Correlação com o log bruto (§10.4)
// =============================================================================================

/** Lê as entradas do log bruto de todos os agentes, a partir de um dia AAAA-MM-DD (opcional), em ordem de ts. */
function lerBrutos({ desdeDia } = {}) {
  const base = caminhos().bruto;
  let pastas = [];
  try {
    pastas = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const todas = [];
  for (const p of pastas) {
    for (const arq of listarJsonl(path.join(base, p))) {
      if (desdeDia && path.basename(arq).slice(0, 10) < desdeDia) continue;
      todas.push(...lerJsonl(arq));
    }
  }
  return ordenarPorTs(todas);
}

/**
 * Comandos brutos de um fluxo (§10.4): os que têm o fluxo_id e, sem fluxo_id, os da mesma sessão e do mesmo
 * agente na janela entre o evento anterior desse agente/sessão e cada evento do fluxo.
 * Cada entrada volta com "correlacao": "fluxo_id" ou "janela".
 */
function brutosDoFluxo(fluxoId, { eventos = [], todosEventos = [], inicio = null } = {}) {
  const d = fluxoId.slice(2, 10);
  const meioDia = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T12:00:00-03:00`);
  const desdeDia = Number.isNaN(meioDia.getTime()) ? undefined : carimbosSP(new Date(meioDia.getTime() - 86400e3)).aaaammdd;
  const brutos = lerBrutos({ desdeDia });
  const t = (x) => Date.parse(x && x.ts);
  const inicioFluxo = inicio ? Date.parse(inicio) : NaN;
  const janelas = [];
  for (const ev of eventos) {
    if (!ev.sessao) continue;
    const fim = t(ev);
    if (Number.isNaN(fim)) continue;
    let ini = -Infinity;
    for (const o of todosEventos) {
      if (o === ev || o.agente !== ev.agente || o.sessao !== ev.sessao) continue;
      const to = t(o);
      if (to < fim && to > ini) ini = to;
    }
    if (ini === -Infinity) ini = (!Number.isNaN(inicioFluxo) && inicioFluxo < fim) ? inicioFluxo : fim - 15 * 60e3;
    janelas.push({ agente: ev.agente, sessao: ev.sessao, ini, fim });
  }
  const saida = [];
  for (const b of brutos) {
    if (b.fluxo_id === fluxoId) saida.push({ ...b, correlacao: 'fluxo_id' });
    else if (!b.fluxo_id && janelas.some((j) => j.sessao === b.sessao && j.agente === b.agente && t(b) > j.ini && t(b) <= j.fim)) {
      saida.push({ ...b, correlacao: 'janela' });
    }
  }
  return saida;
}

// =============================================================================================
// Argumentos de linha de comando, erros e códigos de saída
// =============================================================================================

/** Cria um erro de uso (argumento ou valor errado), code 'EARGS' (sai com 2). */
function erroArgs(mensagem) {
  const e = new Error(mensagem);
  e.code = 'EARGS';
  return e;
}

/**
 * Lê "--nome valor", "--nome=valor", listas repetíveis e chaves booleanas.
 * esp = {texto:[...], lista:[...], bool:[...]}; devolve {op, pos}. Erro de uso lança 'EARGS'.
 */
function lerArgumentos(argv, esp = {}, { maxPosicionais = 0 } = {}) {
  const tipos = new Map();
  for (const n of esp.texto || []) tipos.set(n, 'texto');
  for (const n of esp.lista || []) tipos.set(n, 'lista');
  for (const n of esp.bool || []) tipos.set(n, 'bool');
  const op = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!(a.startsWith('--') && a.length > 2)) { pos.push(a); continue; }
    const igual = a.indexOf('=');
    const nome = igual >= 0 ? a.slice(2, igual) : a.slice(2);
    let valor = igual >= 0 ? a.slice(igual + 1) : undefined;
    const tipo = tipos.get(nome);
    if (!tipo) throw erroArgs(`opção desconhecida: --${nome} (veja --help)`);
    if (tipo === 'bool') {
      if (valor === undefined) op[nome] = true;
      else {
        const v = normalizarEnum(valor);
        if (['1', 'true', 'sim', 's', 'yes'].includes(v)) op[nome] = true;
        else if (['0', 'false', 'nao', 'n', 'no'].includes(v)) op[nome] = false;
        else throw erroArgs(`--${nome} não aceita o valor "${valor}" (use sim ou nao)`);
      }
      continue;
    }
    if (valor === undefined) {
      const prox = argv[i + 1];
      if (prox === undefined || (prox.startsWith('--') && prox.length > 2)) throw erroArgs(`falta o valor de --${nome}`);
      valor = prox;
      i++;
    }
    if (tipo === 'lista') (op[nome] = op[nome] || []).push(valor);
    else {
      if (op[nome] !== undefined) throw erroArgs(`--${nome} foi informado mais de uma vez`);
      op[nome] = valor;
    }
  }
  if (pos.length > maxPosicionais) throw erroArgs(`argumento inesperado: ${pos[maxPosicionais]} (veja --help)`);
  avisarConversaoMsys(op);
  return { op, pos };
}

const RE_PREFIXO_MSYS = /^[A-Za-z]:[\\/]Program Files[\\/]Git[\\/]/i;

/**
 * Rede de proteção do Git Bash: o MSYS troca todo argumento que começa com "/" por um caminho do Windows
 * ("/compact" vira "C:/Program Files/Git/compact") antes de chegar ao node. Avisa no stderr quando vê isso.
 */
function avisarConversaoMsys(op, env = process.env) {
  if (!env.MSYSTEM || env.MSYS_NO_PATHCONV === '1' || env.MSYS2_ARG_CONV_EXCL === '*') return [];
  const suspeitos = [];
  for (const [nome, v] of Object.entries(op)) {
    for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string' && RE_PREFIXO_MSYS.test(x)) suspeitos.push(`--${nome} "${x}"`);
  }
  if (suspeitos.length) {
    avisar(`aviso: o Git Bash pode ter trocado um texto que começava com "/" por um caminho do Windows: ${suspeitos.join(', ')}. `
      + "Confira; para evitar, use o atalho bin/registrar (ou bin/pendencia), rode com MSYS2_ARG_CONV_EXCL='*' na frente, ou mande o JSON por --json -.");
  }
  return suspeitos;
}

/** Interpreta texto JSON que deve ser um objeto; erro de uso ('EARGS') se não for. */
function lerObjetoJson(texto, origem) {
  const t = decodificarTexto(texto).trim();
  if (!t) throw erroArgs(`JSON vazio em ${origem}`);
  let o;
  try { o = JSON.parse(t); } catch (e) { throw erroArgs(`JSON inválido em ${origem}: ${e.message}`); }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw erroArgs(`o JSON em ${origem} precisa ser um objeto ({...})`);
  return o;
}

/** Lê o JSON de "--json -" (entrada padrão), recusando terminal interativo. */
function lerJsonDoStdin() {
  if (stdinInterativo()) throw erroArgs('--json - espera o JSON pela entrada padrão (pipe ou redirecionamento), ex.: node registrar.js evento --json - < ev.json');
  const buf = lerStdinSync();
  const o = lerObjetoJson(buf, 'entrada padrão');
  avisarStdinAscii(buf, o);
  return o;
}

/**
 * O pipe do Windows PowerShell 5 ($OutputEncoding us-ascii) troca acentos e emoji por "?". Se a entrada é
 * 100% ASCII e algum texto tem "??", avisa no stderr e sugere --json-arquivo.
 */
function avisarStdinAscii(buf, objeto) {
  if (!Buffer.isBuffer(buf) || buf.some((b) => b > 0x7f)) return false;
  let suspeito = false;
  const andar = (v) => {
    if (suspeito) return;
    if (typeof v === 'string') { if (v.includes('??')) suspeito = true; return; }
    if (v && typeof v === 'object') for (const x of Object.values(v)) andar(x);
  };
  andar(objeto);
  if (suspeito) {
    avisar('aviso: a entrada padrão chegou só com ASCII e algum texto tem "??": o PowerShell 5 provavelmente trocou acentos e emoji por "?". '
      + 'Use --json-arquivo <arquivo> (aceita UTF-8 e UTF-16) ou rode $OutputEncoding = [Text.UTF8Encoding]::new($false) antes do pipe.');
  }
  return suspeito;
}

/** Lê o JSON de um arquivo (UTF-8 ou UTF-16 com BOM). */
function lerJsonDeArquivo(caminho) {
  let buf;
  try { buf = fs.readFileSync(caminho); } catch (e) { throw erroArgs(`não consegui ler ${caminho}: ${e.code || e.message}`); }
  return lerObjetoJson(buf, caminho);
}

/** Código de saída de um erro: 2 validação/uso, 3 trava esgotada, 1 outros. */
function codigoDeSaida(e) {
  if (!e) return 0;
  if (e.code === 'EARGS' || e.code === 'EVALIDACAO') return 2;
  if (e.code === 'ETRAVA_TEMPO') return 3;
  return 1;
}

/** Mensagem de erro legível (lista os problemas de validação, um por linha). */
function mensagemDeErro(e) {
  if (e && e.code === 'EVALIDACAO') return `${e.message}\n${e.problemas.map((x) => `  - ${x}`).join('\n')}`;
  if (e && e.code === 'ETRAVA_TEMPO') return `${e.message}. Outro processo está segurando a trava; tente de novo em alguns segundos.`;
  return e && e.message ? e.message : String(e);
}

/** Roda a função principal de um comando: erros viram mensagem em stderr e código de saída (0, 1, 2 ou 3). */
function executarComando(principal) {
  try {
    principal();
  } catch (e) {
    process.stderr.write(`erro: ${mensagemDeErro(e)}\n`);
    process.exitCode = codigoDeSaida(e);
  }
}

/** Escreve uma linha na saída padrão. */
function escrever(texto = '') {
  process.stdout.write(`${texto}\n`);
}

/** Escreve um aviso na saída de erro (não muda o código de saída). */
function avisar(texto) {
  process.stderr.write(`${texto}\n`);
}

module.exports = {
  // caminhos
  dirMaestro, raizPadrao, caminhos, barras, tirarAcentos, pastaDoSlug, arquivoEventos, arquivoBruto,
  idSessaoSeguro, arquivoSessao, normalizarCaminho, dentroDe,
  // datas
  FUSO, agora, partesSP, isoSP, dataHoraBR, dataBR, horaBR, carimbosSP, lerData, diaPorExtenso, idadeLegivel,
  // trava e JSON de estado
  PADRAO_TRAVA, aleatorioHex, dormir, pidVivo, exlockExclusiva, adquirirTrava, liberarTrava, comTrava,
  gravarAtomico, gravarJsonAtomico, lerJson, limparTemporariosOrfaos, atualizarJson,
  // JSONL e entrada padrão
  anexarJsonl, lerJsonl, listarJsonl, ordenarPorTs, decodificarTexto, stdinInterativo, lerStdinSync,
  // redação e truncamento
  MARCA_REDIGIDO, segredosDoAmbiente, pareceSegredo, redigir, redigirValor, truncar, resumir,
  // agentes
  carregarAgentes, carregarAgentesSeguro, nomeDaPasta, agentePorDiretorio, identificarAgente,
  // eventos
  ORIGENS_FIXAS, TIPOS_EVENTO, RESULTADOS, TIPOS_COM_DIRECAO, OBRIGATORIOS_EVENTO, CAMPOS_EVENTO, CAMPOS_TRELLO,
  MAX_RESUMO, RE_FLUXO, RE_PENDENCIA, RE_ID_EVENTO, RE_SLUG,
  RE_SHORTLINK, normalizarEnum, textoPreenchido, problemasDoAgente, problemasDaOrigem, validarEvento, gerarIdEvento, idJaUsado,
  completarTrello, trelloDeTexto, problemasDoTrello, ordenarCampos, montarEvento, gravarEvento, erroValidacao, registrarEvento, lerEventos,
  // sessões e fluxos
  sessaoAtual, fluxoDaSessao, atualizarSessao, diagnosticoSessao, mensagemSemFluxo, ultimoFluxoNoTexto,
  // correlação
  lerBrutos, brutosDoFluxo,
  // linha de comando
  erroArgs, lerArgumentos, avisarConversaoMsys, lerObjetoJson, lerJsonDoStdin, avisarStdinAscii, lerJsonDeArquivo, codigoDeSaida, mensagemDeErro,
  executarComando, escrever, avisar,
};
