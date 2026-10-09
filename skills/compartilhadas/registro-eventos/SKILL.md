---
name: registro-eventos
description: 'Compartilhada (todos os agentes) · Use toda vez que receber um pedido, delegar, receber resposta, decidir uma direção, alterar algo, concluir, falhar, ficar bloqueado ou precisar do dono: como registrar o evento com registrar.js (tipo, resumo, direcao, resultado, fluxo), valores permitidos, exemplos bons e ruins, JSON pela entrada padrão para texto com aspas ou emoji, e como abrir pendência com pendencia.js.'
---

# Registro de eventos (log semântico)

**Resultado:** cada coisa relevante que você faz vira **um** evento em `logs/eventos/AAAA-MM.jsonl`, ligado ao fluxo certo, com `resumo` e `direcao` que o dono entende no painel sem perguntar nada.

O log de comandos (log bruto) é automático pelos hooks. O log semântico é seu. Regra completa: `conhecimento/protocolos/registro.md`. Ajuda real do comando: `node bin/registrar.js --help`.

> Caminhos relativos à raiz deste repositório, que no workspace é o `MAESTRO_DIR`.

## Quando usar
| Momento | `--tipo` | `--resultado` típico |
|---|---|---|
| Recebeu um pedido (do dono, do Cérebro, de rotina, de outro agente) | `pedido-recebido` | `em-andamento` |
| Mandou um [PEDIDO] a outro agente | `delegacao` | `em-andamento` |
| Recebeu o [RESPOSTA] | `resposta-recebida` | o status dele (`ok`, `parcial`, `bloqueado`, `aguardando-dono`) |
| Mandou [AVISO] ou [COBRANÇA] | `aviso` | `ok` |
| Escolheu um caminho entre alternativas | `decisao` | `ok` |
| Leu ou consultou algo e respondeu | `consulta` | `ok` |
| Alterou algo (cartão, arquivo, configuração) | `execucao` | `ok`, `parcial`, `falhou` |
| Auditou | `auditoria` | `ok` |
| Entregou um relatório (RST, resumo do dia) | `relatorio` | `ok` |
| Ficou travado por algo externo | `bloqueio` | `bloqueado` |
| Algo deu erro | `erro` | `falhou` |
| Manutenção do workspace (painel, scripts, logs) | `manutencao` | `ok` |
| Precisa do dono | use `pendencia.js abrir` (ele grava o `pendencia-aberta` sozinho) | `aguardando-dono` |

## Quando NÃO usar
- Para cada comando que você roda: isso o log bruto já pega.
- Para pensar em voz alta ou passos intermediários sem efeito: junte-os em `--passo` do evento final.
- Para abrir, responder, resolver ou cancelar pendência: o `pendencia.js` já grava os eventos (`pendencia-aberta`, `decisao`, `pendencia-resolvida`). Não duplique.
- Para guardar senha, token, chave ou credencial: nunca, em campo nenhum.

## Pré-requisitos
- Ter o fluxo `F-AAAAMMDD-NNNN` (do envelope recebido, ou `registrar.js novo-fluxo`, skill `protocolo-delegacao`).
- Sempre a forma canônica: `node bin/registrar.js ...` (com o caminho completo até o `bin/`, se você não estiver na raiz). Nunca o atalho `bin/registrar` sem extensão no PowerShell (não executa nada e não dá erro) nem `registrar.cmd` com texto livre (estraga `^`, `%` e aspas).

## Campos
**Obrigatórios:** `origem`, `tipo`, `resumo`, `resultado`; `agente` e `fluxo_id` também, mas têm padrão (abaixo). `direcao` é obrigatória em `decisao`, `execucao`, `delegacao` e `auditoria` (e recomendada em todo o resto).

**Padrões automáticos:**
- `--agente`: o agente deste terminal (pelo `MAESTRI_TERMINAL_ID` ou pela pasta de trabalho, via `registro/agentes.json`). Só passe se o script disser que não reconheceu.
- `--fluxo`: o fluxo atual da sua sessão (o último `novo-fluxo` ou o último id `F-…` que chegou num prompt). Sem fluxo na sessão, dá erro: passe `--fluxo` explícito. Na dúvida, passe sempre.

**Valores permitidos:**
- `origem`: `dono-direto` (o dono pediu direto a você) · `cerebro` (veio do Cérebro) · `rotina` (veio de uma [ROTINA]) · `agente:<slug>` (veio de outro agente, ex.: `agente:coordenador-trello`) · `sistema`. É a origem do **trabalho**, não quem grava.
- `tipo`: `pedido-recebido`, `delegacao`, `resposta-recebida`, `aviso`, `consulta`, `execucao`, `auditoria`, `relatorio`, `decisao`, `pendencia-aberta`, `pendencia-resolvida`, `bloqueio`, `erro`, `manutencao`, `bootstrap`.
- `resultado`: `ok`, `parcial`, `falhou`, `bloqueado`, `aguardando-dono`, `em-andamento`.
- `projeto` (opcional): o prefixo do projeto no quadro (ex.: `A`, `B`, `C`).

**Opcionais úteis:** `--projeto`, `--trello-shortlink`, `--trello-titulo`, `--trello-url`, `--status-antes`, `--status-depois`, `--passo` (repetível), `--comando` (repetível), `--alteracao` (repetível), `--pendencia P-NNNN` (repetível), `--validacao`, `--proximo-passo`, `--precisa-dono`, `--duracao SEGUNDOS`, `--teste` (o painel esconde).

## Como escrever o `resumo`
Até 100 caracteres, uma linha, começando por verbo no particípio ou substantivo concreto. Diz **o que aconteceu**, com o objeto e o número quando houver.

| Ruim | Bom |
|---|---|
| Fiz coisas no Trello | Criado espelho de A: Formulário de cadastro em 📝 A fazer |
| Relatório | RST gerado: 9 abertas, 11 alertas mecânicos |
| Erro | Falhou leitura do quadro: portal fora do ar |
| Pedido recebido | Pedido do dono: status do projeto Atlas |
| Delegação | Delegada a auditoria semanal ao Coordenador do Trello |
| Ok, feito | Movido espelho de B: Testar a importação para ⏳ Em andamento |
| Painel | Servidor do painel reiniciado na porta 4777 |

## Como escrever a `direcao`
1 a 3 frases: **qual caminho tomou, por quê**, e o que descartou quando for relevante. É o que o dono lê destacado no modal do evento.

- Bom: "Usei o JSON do quadro em vez da interface porque traz espelhos e checklists numa leitura só; nenhuma escrita, quadro ainda em somente leitura."
- Bom: "Movi o espelho em vez de arquivar e recriar, como manda o manual do quadro; o histórico do cartão fica preservado."
- Bom: "Delegada ao Coordenador porque status do Trello é domínio dele; pedi o RST salvo em arquivo porque não cabe numa tela."
- Bom: "Não lapidei o cartão: faltam o resultado esperado e o critério de pronto; abri pendência em vez de inventar contexto."
- Ruim: "Fiz o que foi pedido." (não diz caminho nem porquê)
- Ruim: "Segui o processo." (qual? por quê?)
- Ruim: um parágrafo com cada comando (isso é `--passo` e `--comando`).

## Passo a passo
### 1. Evento simples (texto sem aspas internas)
```
node bin/registrar.js evento --fluxo F-AAAAMMDD-NNNN --origem dono-direto --tipo pedido-recebido --resumo "Pedido do dono: auditar o quadro" --resultado em-andamento
```

### 2. Evento com direção, passos e validação
```
node bin/registrar.js evento --fluxo F-AAAAMMDD-NNNN --origem cerebro --tipo relatorio --resumo "RST gerado: 9 abertas, 11 alertas" --direcao "Li o JSON do quadro porque traz espelhos e checklists numa leitura só." --resultado ok --passo "Li o quadro" --passo "Normalizei" --passo "Gerei o RST" --validacao "9 abertas no JSON = 13 no resumo" --duracao 48
```

### 3. Evento sobre um cartão do Trello
```
node bin/registrar.js evento --fluxo F-AAAAMMDD-NNNN --origem cerebro --tipo execucao --projeto B --trello-shortlink xxxx --trello-titulo "B: Testar a importação de planilhas" --trello-url https://trello.com/c/xxxx --status-antes "A Fazer" --status-depois "Em andamento" --resumo "Movido espelho de B: Testar a importação para Em andamento" --direcao "Troquei a etiqueta e movi o espelho na mesma operação, como manda o manual do quadro." --resultado ok --validacao "Reli o JSON: idList do espelho mudou, o do original não"
```

### 4. Texto com aspas, apóstrofo, emoji, `%`, `^` ou várias frases: JSON pela entrada padrão
Escreva o JSON num arquivo com a ferramenta **Write** (nunca heredoc ou `echo`: o Git Bash come barras invertidas), por exemplo `<tmp>/maestro-ev.json` (`<tmp>` é a pasta temporária do sistema, escrita com barras normais):
```json
{
  "fluxo_id": "F-AAAAMMDD-NNNN",
  "origem": "cerebro",
  "tipo": "execucao",
  "projeto": "B",
  "trello": {"shortLink": "xxxx", "titulo": "B: Testar a importação de planilhas", "url": "https://trello.com/c/xxxx", "status_antes": "A Fazer", "status_depois": "Em andamento"},
  "resumo": "Movido espelho de B: Testar a importação para ⏳ Em andamento",
  "direcao": "Troquei a etiqueta no original e movi o espelho arrastando no quadro, como manda o manual; não usei o 'Mover' do diálogo porque ele move o original.",
  "passos": ["Troquei a etiqueta A Fazer por Em andamento", "Arrastei o espelho", "Reli o JSON"],
  "alteracoes": ["Etiqueta do original: A Fazer → Em andamento", "Espelho: 📝 A fazer → ⏳ Em andamento"],
  "resultado": "ok",
  "validacao": "Reli o JSON às 15:42: idList do espelho mudou, o do original não"
}
```
Depois mande por uma destas formas (todas equivalentes):
```
node bin/registrar.js evento --json - < <tmp>/maestro-ev.json
```
(Git Bash)
```
Get-Content <tmp>/maestro-ev.json -Encoding utf8 | node bin/registrar.js evento --json -
```
(PowerShell; no Windows PowerShell 5, rode antes `$OutputEncoding = [Text.UTF8Encoding]::new($false)`, senão acentos e emoji viram `?`)
```
node bin/registrar.js evento --json-arquivo <tmp>/maestro-ev.json
```
(qualquer shell; aceita BOM e UTF-16 do PowerShell 5; o melhor caminho no PowerShell)

Opções da linha de comando têm prioridade sobre o JSON (dá para mandar o JSON e sobrescrever só `--resultado`, por exemplo).

### 5. Precisa do dono: pendência
Não registre `pendencia-aberta` à mão. Abra a pendência; o script grava o evento (`aguardando-dono`, `precisa_dono`) e imprime o id:
```
node bin/pendencia.js abrir --fluxo F-AAAAMMDD-NNNN --severidade alta --tipo decisao --titulo "Eco: definir etiqueta e prefixo" --contexto "A coluna nova Eco é amarela e o único cartão usa a etiqueta Boreal; o prefixo E: está livre." --opcao "A: etiqueta Eco amarela, prefixo E:" --opcao "B: manter o cartão em Boreal, sem coluna própria" --recomendacao "A, porque segue o manual do quadro: um projeto, uma etiqueta e um prefixo." --trello xxxx
```
- `--tipo`: `aprovacao`, `decisao`, `informacao-faltando`, `revisao`. `--severidade`: `critica` (trava algo importante ou tem risco), `alta` (trava uma frente), `normal` (padrão), `baixa`.
- Texto com aspas ou emoji: JSON com os campos `fluxo_id`, `severidade`, `tipo`, `titulo`, `contexto`, `opcoes` (lista), `recomendacao`, `trello`, e `pendencia.js abrir --json - < arquivo.json` (ou `--json-arquivo`).
- Depois: se você não é o Cérebro, mande [AVISO] ao Cérebro com o id (skill `protocolo-delegacao`). Crítica aberta fora do terminal Maestro não notifica o dono: o script avisa e o Cérebro notifica.
- Cite o id nos eventos seguintes do fluxo: `--pendencia P-NNNN`.

## Correlação de fluxo (como os eventos e comandos se ligam no painel)
- `registrar.js novo-fluxo` torna aquele fluxo o atual da sua sessão.
- Um prompt que chega com `F-AAAAMMDD-NNNN` (envelope, rotina) faz o hook gravar esse fluxo como atual da sessão; os comandos seguintes herdam o id até chegar outro.
- Use **o mesmo id** em todos os eventos do trabalho, inclusive nos sub-pedidos. Nunca invente nem reaproveite id de outro assunto.
- Conferir a sequência inteira: `node bin/registrar.js fluxo F-AAAAMMDD-NNNN`.

## Como validar
1. O comando imprime o id `EV-AAAAMMDD-HHMMSS-xxxx` e sai com 0.
2. `node bin/registrar.js ultimos --horas 1 --agente <seu-slug>` mostra o evento com o slug certo (não `desconhecido`).
3. Código de saída 2: a mensagem lista cada campo errado. Corrija e mande de novo (nada foi gravado).
4. Código 3: trava esgotada (outro processo gravando). Tente de novo uma vez; persistindo, registre depois e siga.

## Armadilhas
- `resumo` com mais de 100 caracteres ou com quebra de linha é recusado.
- `direcao` faltando em `decisao`, `execucao`, `delegacao` ou `auditoria` é recusada.
- Acentos no tipo são aceitos (`execução` vira `execucao`), mas escreva sem acento.
- `origem` errada confunde o painel: é de onde veio o trabalho (o dono direto, o Cérebro, rotina, outro agente).
- Eventos de teste sempre com `--teste` (ou `"teste": true`), senão aparecem no painel como reais.
- Hora: não passe `ts`; o script põe a hora local do fuso de São Paulo. Se passar, ISO com fuso (`-03:00`), nunca `Z`.
- Ferramentas que resumem a saída do terminal (proxies de token, por exemplo) podem cortar `cat` e afins; para ler o log inteiro use `registrar.js ultimos` ou `fluxo`, ou a ferramenta Read.

## Checklist final
- [ ] Um evento por momento relevante (pedido, delegação, resposta, decisão, alteração, conclusão, falha, bloqueio).
- [ ] Fluxo certo em todos os eventos do trabalho.
- [ ] `origem`, `tipo` e `resultado` com valores permitidos.
- [ ] `resumo` concreto, até 100 caracteres.
- [ ] `direcao` com caminho e porquê (obrigatória em decisao, execucao, delegacao, auditoria).
- [ ] Cartão do Trello: shortLink, título, status antes e depois.
- [ ] `validacao` diz como foi confirmado.
- [ ] Precisa do dono → `pendencia.js abrir`, sem evento duplicado; Cérebro avisado.
- [ ] Nenhum segredo em campo nenhum.
- [ ] Conferido com `registrar.js ultimos`.
