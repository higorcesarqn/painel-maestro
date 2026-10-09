---
name: painel
description: 'Cérebro Principal · Use para manter o painel local (http://127.0.0.1:4777) no ar e com dado fresco: subir, checar, parar ou reiniciar o servidor no terminal Shell "Servidor do Painel" (maestri ask --raw, PID em estado/painel.pid), abrir e conferir o portal "Painel", diagnosticar selo amarelo ou vermelho, dado velho, hooks parados ou uso indisponível, e pedir ao Coordenador do Trello uma leitura nova do quadro.'
---

# Painel (Cérebro Principal)

**Resultado:** o painel responde em `http://127.0.0.1:4777`, o selo de saúde está verde (ou cada motivo amarelo/vermelho tem dono e próximo passo), e o portal **"Painel"** mostra o que os arquivos do `MAESTRO_DIR` dizem.

Caminhos relativos à raiz deste repositório, o `MAESTRO_DIR` (por exemplo, `<raiz do workspace>/_maestro`). Nas instruções dos agentes, escreva-os como caminho absoluto. Fonte de verdade técnica: `painel/README.md` (rotas, segurança, variáveis, diagnóstico). Esta skill é o procedimento.

## Antes de começar
- O servidor (`painel/servidor.js`) e a página compilada (`painel/index.html`, app Preact de `painel/ui/`) estão no repositório. Toda tela nova é um item do menu, nunca uma página separada (passo a passo no `painel/README.md`, seção "A página").
- O dono responde pendências na tela Pendências; a resposta chega ao terminal do Cérebro como `[RESPOSTA DO DONO PELO PAINEL] ...` (skill `pendencias`). Isso depende de o servidor rodar dentro de um terminal do Maestri (`/api/estado` → `respostas.aviso_cerebro: true`).
- Quando o Maestri reinicia, o terminal Shell volta vazio: suba o servidor de novo (passo 2).
- O `ask --raw` manda teclas ao terminal Shell: `\n` sobe o comando e `\x03` é Ctrl+C. Ele volta na hora; confira a tela com `maestri check`. Registre essa convenção como decisão do seu workspace antes do primeiro uso.

## Mudar a página (build e publicação)
1. Fonte em `painel/ui/src` (telas em `telas/`, CSS de cada tela em `estilo/<tela>.css`, componentes em `componentes/`). Para ver ao vivo: `cd painel/ui && npx vite --host 127.0.0.1 --port 5173 --strictPort` (em segundo plano; `/api` vai para o painel real; `?mock=1` usa dados de teste). Capturas de tela **numa aba nova** do Playwright (`page.context().newPage()`): o dono pode estar olhando a aba padrão.
2. Publicar: `cd painel/ui && npm run build` (grava `painel/index.html`), depois `node painel/testes/rodar-todos.js` (tem de dar TUDO OK).
3. Mudou `servidor.js` ou `api-*.js`: reinicie o servidor (passo 4). Mudou só a página: não precisa.
4. **Recarregar o portal:** navegar para o mesmo endereço mudando só o `#` não recarrega, e passar por `about:blank` também não. Use um endereço diferente e depois volte ao limpo:
   ```
   maestri portal navigate "Painel" "http://127.0.0.1:4777/?r=1#visao"
   maestri portal navigate "Painel" "http://127.0.0.1:4777/#visao"
   maestri portal screenshot "Painel"
   ```
   O título da aba é "<Tela> · Painel <nome do workspace>" (`maestri portal info`). `portal evaluate` não funciona aqui: a CSP do painel bloqueia `eval`, de propósito.
5. Commit no git do repositório e evento `execucao` com o que mudou.

## Como o painel funciona (o mínimo para operar)
- **Servidor** (`painel/servidor.js`, Node, só biblioteca padrão), escuta **só em 127.0.0.1:4777**. A cada requisição lê os arquivos do `MAESTRO_DIR`. Não usa IA nem tokens. Grava o próprio PID em `estado/painel.pid` e roda o coletor de uso na subida e a cada 5 min.
- **Página** (`painel/index.html`, arquivo único) consulta `/api/estado` a cada 20 s.
- **De onde vem cada dado:**
  | No painel | Arquivo | Quem grava |
  |---|---|---|
  | Agentes, cores, modelo, skills | `registro/agentes.json` | Cérebro |
  | Tabela de log, modal | `logs/eventos/AAAA-MM.jsonl` | `bin/registrar.js` (todos os agentes) |
  | Comandos brutos, saúde dos hooks | `logs/bruto/<agente>/AAAA-MM-DD.jsonl` | hooks (`bin/hook_log.js`) |
  | Pendências | `estado/pendencias.json` | `bin/pendencia.js` |
  | Trello (números, cards, auditoria, gráfico) | `estado/trello/resumo.json`, `rst.md`, `serie.jsonl` | Coordenador do Trello (leitura do quadro) |
  | Uso do Claude | `estado/uso.json` (← `~/.maestri/usage/providers/.status.json` e transcrições) | `bin/coletar_uso.js` |
- **O que custa tokens** é só atualizar o Trello (um agente lê o quadro): uma rotina de leitura do Trello ou um pedido seu.
- Rotas: `GET /`, `GET /api/estado`, `GET /api/eventos?...` (com `contagens`), `GET /api/evento/<id>`, `GET /api/fluxo/<id>`, `POST /api/recalcular` (exige cabeçalho `X-Painel: 1`), `POST /api/pendencias/<id>/responder` (resposta do dono; grava e avisa o Cérebro), `POST /api/cerebro` (501: ainda não implementado), `GET /prospeccao` (302 para `/#prospeccao`) e as `/api/prospeccao/*`.

## Quando usar
- Ao iniciar a sessão, se o dono usa o painel: checar se está no ar.
- O dono diz que o painel está fora, velho, vermelho ou com número estranho.
- Depois de mudar `servidor.js`, `index.html`, `coletar_uso.js` ou `agentes.json` (reiniciar só para código do servidor; dado novo aparece sozinho).
- Numa rotina semanal de manutenção: conferir a saúde.

## Quando NÃO usar
- Para responder status do Trello ao dono: skill `orquestracao` (o painel é para o dono olhar; você lê `rst.md`/`resumo.json` ou pede o RST).
- Para mexer no Trello: nunca; peça ao Coordenador.
- Botão "Pedir ao Cérebro" (`POST /api/cerebro`): não existe ainda; implementar só com ok do dono (pendência normal).

## Pré-requisitos
- `maestri list` mostra "Servidor do Painel" (terminal Shell) e o portal "Painel" (`http://127.0.0.1:4777`) ligados a você. Se faltar o terminal: passo 1. Se faltar o portal: confira os nomes em `maestri list` antes de criar outro (o dono pode ter renomeado).
- A convenção do `ask --raw` registrada (seção "Antes de começar").

## Passo a passo
### 1. Criar o terminal e o portal (uma vez só)
```
maestri recruit "Servidor do Painel" --preset "Shell"
maestri list
```
O terminal nasce ligado a você, com o shell do preset. Depois de o servidor subir (passo 2):
```
maestri portal create "http://127.0.0.1:4777" "Painel"
maestri list
```
Use `127.0.0.1`, nunca `localhost` (o `localhost` tenta `::1` primeiro). Atualize `conectado_a` do Cérebro em `registro/agentes.json` se faltar `portal:Painel`. Registre `manutencao`. Só recrie o portal se ele sumir de `maestri list`, e com o nome atual.

### 2. Subir o servidor
1. Confira que não há outro rodando:
   ```
   node skills/cerebro/painel/checar-painel.js
   ```
   Saída 2 com `FORA DO AR` e sem processo vivo: pode subir. Se o PID existe e a API responde, já está no ar: pare aqui.
2. Mande o comando ao terminal Shell (timeout da ferramenta: 30 s; **nunca reenvie**), com o caminho absoluto do servidor:
   ```
   maestri ask "Servidor do Painel" --raw "node <raiz do workspace>/_maestro/painel/servidor.js\n"
   ```
3. Confira a tela:
   ```
   maestri check "Servidor do Painel"
   ```
   Esperado: `Painel no ar em http://127.0.0.1:4777 (PID <n>)`. Se aparecer `a porta 4777 já está em uso`, vá ao diagnóstico.
4. Rode de novo o `checar-painel.js`: PID existe e `API: no ar`.

**Sem terminal Shell (recurso):** PowerShell, processo destacado, sem janela:
```
Start-Process -FilePath node -ArgumentList '<raiz do workspace>/_maestro/painel/servidor.js' -WindowStyle Hidden
```
A saída do servidor se perde (os erros do coletor ficam só em `/api/estado` → `coletor`); o PID fica em `estado/painel.pid`. Registre `decisao` dizendo por que não usou o terminal Shell. Não suba pela ferramenta Bash em primeiro plano (trava a sua sessão).

### 3. Checar
```
node skills/cerebro/painel/checar-painel.js
```
Mostra PID e se o processo existe, se `index.html` existe, a hora da última leitura do Trello, e da API: `gerado_em`, selo (`verde`/`amarelo`/`vermelho`), cada motivo, idade do Trello, do último evento e do uso. Saída: 0 verde · 1 amarelo/vermelho · 2 fora do ar · 3 uso inválido (`--help` mostra as opções).

No portal "Painel" (para recarregar, use um endereço diferente e depois o limpo, como em "Mudar a página", passo 4):
```
maestri portal navigate "Painel" "http://127.0.0.1:4777/?r=1#visao"
maestri portal navigate "Painel" "http://127.0.0.1:4777/#visao"
maestri portal screenshot "Painel"
```
Leia o screenshot. Confira contra os arquivos: pendências = `node bin/pendencia.js listar --abertas`; números do Trello = linha "1. Números" de `estado/trello/rst.md`; eventos recentes = `node bin/registrar.js ultimos --horas 2`.

### 4. Parar ou reiniciar
- Ctrl+C no terminal:
  ```
  maestri ask "Servidor do Painel" --raw "\x03"
  maestri check "Servidor do Painel"
  ```
  Esperado: `Encerrando o painel (SIGINT)...` e o prompt do shell de volta. O `painel.pid` é apagado na saída.
- PowerShell (quando não há terminal ou o Ctrl+C não pegou):
  ```
  Stop-Process -Id (Get-Content <raiz do workspace>/_maestro/estado/painel.pid)
  ```
- Git Bash: `taskkill //PID $(cat <raiz do workspace>/_maestro/estado/painel.pid) //F` (barra dobrada por causa da conversão de `/`; `kill $!` não derruba o node).
- Reiniciar = parar, conferir `FORA DO AR` no `checar-painel.js`, subir (passo 2).
- Reinicie só quando mudar o código do servidor ou do coletor. Mudança em `agentes.json`, eventos, pendências e Trello aparece sozinha na próxima consulta.

### 5. Diagnosticar
Passe o mouse no selo (ou leia `saude.motivos` no `checar-painel.js`). Cada motivo tem uma causa:
| Sintoma | Causa provável | O que fazer |
|---|---|---|
| `FORA DO AR (ECONNREFUSED)` | Servidor parado (terminal fechado, Maestri reiniciado, erro) | `maestri check "Servidor do Painel"` para ver o erro; subir (passo 2) |
| `a porta 4777 já está em uso` | Outro painel rodando ou outro programa | `checar-painel.js` (PID vivo?); o comando de porta abaixo da tabela mostra o PID dono da porta; se for painel antigo, pare e suba de novo |
| PID no arquivo, processo não existe | Parado com `taskkill /F` (não limpa o arquivo) | Inofensivo: a próxima subida grava por cima |
| `GET /` 503 | Falta `painel/index.html` | Gere de novo: `cd painel/ui && npm run build` (seção "Mudar a página", passo 2) |
| "Trello lido há …" (amarelo > 120 min, vermelho > 240 min, contando 8–22 h) ou "Trello ainda não foi lido" | A rotina de leitura não rodou (Maestri fechado, rotina pausada, Coordenador ocupado ou com erro) ou ainda não existe | `maestri routine list`; último evento do Coordenador (`node bin/registrar.js ultimos --agente coordenador-trello --horas 6`); pedir leitura (passo 6) |
| "<agente>: nenhum log bruto ainda (hooks instalados?)" ou "sem log bruto há …" | Hooks não gravam para aquele agente | Confira o hook no `settings.json` do Claude Code (README do repositório, "Instale o hook"); veja se há arquivo do dia em `logs/bruto/<slug>/`; pasta `logs/bruto/desconhecido-<id>` = `terminal_id` errado ou vazio em `agentes.json`: corrija o campo. Agente parado de propósito: troque o `status` dele para algo diferente de `ativo` |
| Uso do plano "indisponível" | Uso desligado no Maestri, anéis não visíveis, ou consulta do Maestri falhou | Ler `~/.maestri/usage/providers/.status.json` (`state`, `error`, `lastSuccessAt`); pedir ao dono para abrir Configurações → Agentes → Uso no Maestri; não invente número |
| Consumo por agente zerado | Nenhuma sessão com dono em `estado/sessoes/` | Hooks instalados? Sessão iniciada antes dos hooks? `estado/uso.json` → `coleta` diz quantas sessões ficaram sem dono |
| Número do painel ≠ número do RST | Painel lê `resumo.json`; RST pode ser de outra leitura | Comparar `coletado_em` do `resumo.json` com o cabeçalho do `rst.md` |
| `avisos` em `/api/estado` | Linhas JSONL ilegíveis | Ver o arquivo citado; não apague logs (exclusão é do dono) |
| Arquivo de estado ilegível (`agentes.json`, `pendencias.json`, `resumo.json`) | JSON quebrado por edição manual | Validar: `node -e "JSON.parse(require('fs').readFileSync('registro/agentes.json','utf8'));console.log('ok')"` (rodando na raiz do repositório); corrigir o arquivo que é seu; o resto, pedir ao dono do arquivo |
| Botão Recalcular não muda nada | Coletor só relê o que mudou; plano indisponível continua até o Maestri gravar | Esperar; erros em `coletor.ultima` |

Quem está na porta 4777 (PowerShell ou cmd; a última coluna é o PID):
```
netstat -ano | findstr :4777
```

### 6. Pedir atualização do Trello ao Coordenador
Painel com Trello velho, ou o dono pediu "atualiza o painel". Use a skill `protocolo-delegacao`:
```
[PEDIDO] F-AAAAMMDD-NNNN
De: Cérebro Principal → Para: Coordenador do Trello
Origem: dono (conversa com o Cérebro) | Cérebro (manutenção do painel)
Tipo: consulta
Pedido: leia o quadro inteiro pelo JSON e atualize snapshot-bruto.json, resumo.json, serie.jsonl e rst.md.
Contexto: o painel mostra a leitura de <hora do coletado_em atual>.
Entregar: [RESPOSTA] com a hora da leitura e a linha 1. Números do RST.
Pronto quando: estado/trello/resumo.json com coletado_em depois de <hora do pedido>.
Autonomia: somente leitura, nenhuma escrita no Trello.
Urgência: normal
```
Depois: `checar-painel.js` mostra a nova hora em "Trello: última leitura" e a idade do Trello caiu.

## Como validar
- `checar-painel.js` sai com 0 (ou 1 com cada motivo explicado e encaminhado).
- Screenshot do portal "Painel" confere com `pendencia.js listar --abertas`, `rst.md` e `registrar.js ultimos`.

## Como registrar
| Momento | `--tipo` | `--resumo` (exemplo) | `--direcao` (exemplo) |
|---|---|---|---|
| Subiu ou reiniciou | `manutencao` | "Painel no ar: porta 4777, PID 12345" | "Subi pelo terminal Servidor do Painel com ask --raw; reinício porque mudou o servidor.js." |
| Diagnosticou e corrigiu | `manutencao` | "Corrigido terminal_id do Coordenador: hooks voltaram a gravar" | "A pasta desconhecido-<id> mostrava o id real; atualizei agentes.json em vez de reinstalar hooks." |
| Pediu leitura do Trello | `delegacao` | "Pedida leitura do quadro ao Coordenador" | "Trello há 300 min no painel; leitura somente de leitura, sem escrita." |
| Não conseguiu | `bloqueio` ou `erro` | "Falhou subida do painel: porta 4777 ocupada por outro programa" | — |
Origem: `cerebro` (manutenção sua), `dono-direto` (o dono pediu) ou `rotina`. Fluxo: o do pedido, ou `node bin/registrar.js novo-fluxo --titulo "Painel · manutenção"`.

## Armadilhas
- **Nunca `0.0.0.0`** nem outra interface: com VPN ou rede compartilhada, o painel ficaria exposto (ele não tem login).
- **Nunca reenviar** `ask --raw` com o comando de subida: dois servidores disputam a porta. Confira com `maestri check`.
- **Barra invertida:** só as sequências `\n`, `\r`, `\x03` do `--raw`. Caminho sempre com barra normal.
- **`taskkill /PID` no Git Bash** vira caminho: use `//PID` e `//F`, ou o PowerShell.
- **Portas 4790 a 4799 são dos testes**; o painel real é 4777.
- **Subir o servidor na sua própria ferramenta Bash em primeiro plano** trava a sessão.
- **Selo verde não prova dado certo**: confira um número contra a fonte de vez em quando.
- **Não apague arquivo** (logs, estado, nem o `uso-cache.json`): excluir arquivo é do dono (protocolo de autonomia, nível 3). O `uso-cache.json` é só cache e o coletor relê tudo sem ele, então, se precisar zerá-lo, peça o ok ao dono com esse motivo.

## Checklist final
- [ ] Convenção do `ask --raw` registrada antes do primeiro uso.
- [ ] Testes do painel passaram antes da primeira subida real.
- [ ] "Servidor do Painel" e portal "Painel" aparecem em `maestri list`.
- [ ] `checar-painel.js`: PID vivo, API no ar, selo verde ou motivos encaminhados.
- [ ] Trello com leitura recente ou pedido feito ao Coordenador.
- [ ] Hooks gravando para todo agente `ativo`.
- [ ] Evento `manutencao` (ou `delegacao`/`bloqueio`) registrado.
