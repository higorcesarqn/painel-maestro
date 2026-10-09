# Painel do workspace

Painel local de um workspace multiagente (Maestri + Claude Code). Um servidor Node.js só com a biblioteca padrão (`servidor.js`) serve a página (`index.html`) e uma API JSON que lê, a cada requisição, os arquivos de `_maestro/`. Não usa IA nem gasta tokens. O que custa tokens é atualizar o Trello, que é trabalho do Coordenador (rotina ou pedido).

| Arquivo | O que é |
|---|---|
| `painel/servidor.js` | servidor HTTP e API (Node 22, CommonJS, sem dependências) |
| `painel/ui/` | **fonte da página**: app Preact com identidade visual própria (telas, componentes, gráficos em SVG). O build gera o `index.html` |
| `painel/index.html` | a página compilada (arquivo único, sem nada externo; não edite à mão: rode o build do `ui/`) |
| `painel/prospeccao.html` | o dashboard antigo da prospecção, servido em `/prospeccao/antiga` por compatibilidade; a Prospecção agora é tela do app |
| `painel/api-prospeccao.js` | a API da prospecção: lê o banco pela `bin/prospeccao/lib_prospeccao.js` e altera leads pelo `leads.js` |
| `painel/api-pendencias.js` | resposta de pendência pelo painel: grava pelo `pendencia.js responder` e avisa o Cérebro (`maestri ask`) |
| `bin/coletar_uso.js` | coletor de uso do Claude, chamado pelo servidor e pela linha de comando |
| `bin/janela-horario.js` | filtro de horário para o `--pre-run` das rotinas |
| `painel/testes/` | testes sem framework (`rodar-todos.js`) |

## Subir

Num terminal comum (no Maestri, um terminal shell no canvas, não um agente), na raiz do repositório:

```
node painel/servidor.js
```

Ele imprime `Painel no ar em http://127.0.0.1:4777 (PID 12345)`, grava o PID em `estado/painel.pid` (dentro do `MAESTRO_DIR`) e roda o coletor de uso na hora e depois a cada 5 minutos (no próprio processo, sem travar as requisições). Abra `http://127.0.0.1:4777` no navegador ou num portal do Maestri; `/prospeccao` leva à tela Prospecção do app (use `127.0.0.1`, não `localhost`). A página se atualiza sozinha a cada 20 segundos.

Outra porta: `--porta 4780` ou a variável `PAINEL_PORTA` (o `--porta` vale mais).

## Parar

- **Ctrl+C** no terminal do servidor. Ele apaga o `estado/painel.pid` ao sair.
- **PowerShell:** `Stop-Process -Id (Get-Content estado/painel.pid)`
- **cmd:** `taskkill /PID <pid de estado/painel.pid> /F`
- **Git Bash:** `taskkill //PID $(cat estado/painel.pid) //F`. No Git Bash, `kill $!` não derruba o node (o `$!` é o PID do MSYS, não o do Windows).

Com `taskkill /F` o processo morre sem chance de limpar, então o `painel.pid` antigo fica no disco. Isso não atrapalha: a próxima subida grava o PID novo por cima.

## Portas e segurança

- **4777** é a porta padrão do painel. Os testes usam só **4790 a 4799**.
- Escuta **só em 127.0.0.1**: outros endereços de rede da máquina não alcançam o painel.
- O cabeçalho `Host` precisa ser exatamente `127.0.0.1:<porta>` ou `localhost:<porta>`; qualquer outro recebe **403** (protege contra DNS rebinding).
- `POST` só com o cabeçalho `X-Painel: 1` (e, se vier `Origin`, ele precisa ser o próprio painel); senão **403**. Outra página aberta no navegador não consegue acionar o servidor.
- Nenhum cabeçalho CORS. Só existem `/`, `/prospeccao` (302 para `/#prospeccao`), `/prospeccao/antiga` e `/api/*`: qualquer outro caminho (inclusive `/index.html`, `/prospeccao.html`, `/../` e afins) é **404**. Nenhum arquivo é servido pelo nome.
- Toda resposta leva `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` e `X-Frame-Options: DENY`; o HTML leva uma `Content-Security-Policy` que bloqueia qualquer recurso externo (a página é um arquivo único) e, com `frame-ancestors 'none'`, impede que outro site embuta o painel num iframe para induzir cliques (clickjacking no Recalcular, por exemplo).

## Rotas

| Rota | Devolve |
|---|---|
| `GET /` | o `index.html` (503 com aviso se o arquivo não existir) |
| `GET /api/estado` | tudo da tela inicial: `gerado_em`, `workspace`, `saude`, `kpis`, `agentes`, `pendencias`, `trello`, `trello_rst`, `serie_trello`, `uso`, `eventos` (+ `coletor` e `avisos`) |
| `GET /api/eventos?desde=&ate=&horas=&agente=&projeto=&tipo=&resultado=&q=&so_dono=1&incluir_testes=1&fluxo=&pagina=1&por_pagina=50` | `{total, pagina, por_pagina, paginas, eventos, contagens}` de todos os meses, mais recente primeiro. `contagens` = `{resultado, agente, projeto, tipo, precisa_dono}` do conjunto filtrado, sem paginação; cada faceta ignora o próprio filtro (os chips mostram o que dá para escolher) e `precisa_dono` ignora o `so_dono` |
| `GET /api/evento/<id>` | `{evento, fluxo, pedido_inicial, sequencia, comandos_brutos, comandos_truncados, comandos_omitidos, comandos_aviso, janela_sem_fluxo, anterior_id, proximo_id}`; 404 se não existir |
| `GET /api/fluxo/<id>` | `{fluxo, eventos, comandos_brutos, comandos_truncados, comandos_omitidos, comandos_aviso, pedido_inicial}`; `?incluir_testes=1` traz os eventos de teste |
| `POST /api/recalcular` | roda o coletor de uso e devolve o mesmo corpo de `/api/estado` (+ `recalculo`) |
| `POST /api/cerebro` | 501: reservado para uma fase futura (conversa com o Cérebro pelo painel) |
| `POST /api/pendencias/<P-NNNN>/responder` | corpo `{"opcao": "A", "texto": "..."}` (pelo menos um; texto até 2000 caracteres): grava a resposta pelo `pendencia.js responder` (status `respondida`, evento `decisao` no fluxo da pendência) e avisa o Cérebro no terminal dele. Devolve `{ok, pendencia, aviso_cerebro: {enviado, para \| motivo}}`; 409 se a pendência não estiver aberta, 404 se não existir, 400 para corpo ou opção inválidos |
| `GET /prospeccao` | **302** para `/#prospeccao` (a tela Prospecção do app), com um link no corpo para quem não segue o redirecionamento |
| `GET /prospeccao/antiga` | o `prospeccao.html` antigo (503 com aviso se faltar), mantido por compatibilidade; CSP própria que libera só a fonte do Google |
| `GET /api/prospeccao/estado` | tudo do dashboard da prospecção (ver a seção Prospecção) |
| `GET /api/prospeccao/lead/<id>` | `{gerado_em, lead, portal}`: o lead completo, com histórico; 404 se não existir |
| `POST /api/prospeccao/assumir` | corpo `{"lead_id": "…"}`: pausa o agente nesse lead (`humano.por = "painel"`) |
| `POST /api/prospeccao/devolver` | corpo `{"lead_id": "…"}`: devolve o lead ao agente; 409 se ele não estava com o humano |

Detalhes dos filtros de `/api/eventos`:
- `desde` e `ate` em `AAAA-MM-DD`, pelo dia de São Paulo (valor inválido → 400). `horas=N` traz só as últimas N horas (o "24 h" do Log).
- `agente`, `projeto`, `tipo` e `resultado` aceitam vários valores separados por vírgula; `projeto` não diferencia maiúsculas.
- `q` procura em `resumo`, `direcao`, título do cartão do Trello e `fluxo_id`, sem diferenciar maiúsculas nem acentos; cada palavra precisa aparecer, em qualquer ordem.
- `so_dono=1` traz só `precisa_dono: true` ou resultado `falhou`, `bloqueado` ou `aguardando-dono`.
- Eventos com `teste: true` só aparecem com `incluir_testes=1`.
- `por_pagina` vai até 500.

Correlação do modal: `comandos_brutos` traz as entradas do log bruto com o mesmo `fluxo_id` (de todos os agentes, nos dias do fluxo) e, para as entradas sem `fluxo_id`, as do mesmo agente (e da mesma sessão, quando o evento tem `sessao`) entre o evento anterior desse agente e o atual (sem evento anterior: desde o início do fluxo, se for antes, ou 15 min antes, como o `registrar fluxo`), limitado às 6 h anteriores. Cada comando diz como foi ligado: `correlacao: "fluxo_id"` ou `"janela"`. O `pedido_inicial` ("O que foi pedido") parte do primeiro evento `pedido-recebido` do fluxo: o texto é o do prompt bruto que trouxe o pedido, ou seja, o último `UserPromptSubmit` do mesmo agente (e da mesma sessão, quando o evento tem `sessao`) entre o evento anterior desse agente e o `pedido-recebido` (no máximo 6 h antes; `fonte: "prompt-do-evento"`), com a origem do evento. Isso pega o pedido do dono mesmo sem `fluxo_id` no log bruto (o id só nasce depois do pedido). Sem esse prompt, vale o campo `pedido`/`texto` do evento ou o resumo (`fonte: "evento"`). Sem evento `pedido-recebido`, vem do primeiro prompt bruto que trouxe o id do fluxo (`fonte: "prompt"`, origem deduzida do envelope: `[ROTINA]`, `[PEDIDO] … De: …`). `anterior_id` e `proximo_id` seguem a ordem do tempo e só apontam para eventos com id válido (eventos sem id em texto ficam fora da lista e contam em `avisos`).

Log bruto grande: cada arquivo do log bruto vira um índice compacto na memória (hora, posição da linha, sessão, `fluxo_id` e ids citados nos prompts), lido de forma incremental; só as linhas escolhidas são relidas do disco. Numa consulta, o servidor lê no máximo 160 MB novos do log bruto: o que não couber fica para a próxima vez e a resposta sai com `comandos_truncados: true` e o motivo em `comandos_aviso` (o modal mostra "Leitura parcial do log bruto"). Acima de 1500 comandos ficam os mais próximos do evento (`comandos_omitidos` diz quantos saíram). Fluxo com mais de 62 dias: entram a véspera e o 1º dia (pedido inicial) e os 60 dias mais recentes; o meio sai, com aviso.

## A página (`index.html`, fonte em `ui/`)

App Preact (a API do React em 4 KB) com componentes próprios e gráficos em SVG desenhados no código, compilado pelo Vite num **arquivo único**: o JS, o CSS e a fonte Manrope 300/400 (subconjunto latino, como `data:`) vão dentro do HTML. Nada externo, então a CSP do servidor continua a mesma. Medido para um portal do canvas de **1520 × 1095**: nenhuma tela rola a página; listas e tabelas rolam por dentro dos cartões.

**Identidade visual:** fundo `#000`, cartões `#101010` com borda `1px #242424` e raio 14px, texto `#F5F5F5`, secundário `#888`, azul `#0000FF` só como acento (`#4F6BFF` quando é texto), rótulos em caixa alta com `.3em`, ícones Lucide com traço 1,75, sem emoji e sem gradiente. As cores ficam em variáveis no topo de `ui/src/estilo/base.css`.

**Menu = telas.** Toda tela nova é um item do menu, nunca uma página separada:
1. um item em `ABAS` (`ui/src/dados/contexto.js`), com `id`, `nome`, `titulo` e `grupo` (`workspace` ou `operacoes`; um bloco novo do menu é um item novo em `GRUPOS`, no mesmo arquivo);
2. um componente em `TELAS` (`ui/src/app/App.jsx`) e um ícone em `ICONES` (`ui/src/app/Lateral.jsx`);
3. a tela em `ui/src/telas/<Nome>.jsx`, com o CSS dela em `ui/src/estilo/<nome>.css`, importado pela própria tela.
A tela fica em `#<id>` na URL (com sub-abas, `#<id>/<sub>`: o App entrega a sub-aba em `subrota`); as setas ↑ ↓ com o foco no menu passam de uma tela para outra, de um grupo para o outro.

**Componentes prontos** (`ui/src/componentes/`): `Cartao` (com `rotulo`, `info`, `acoes`, `rola`), `Kpi` (número grande, `info`, `destaque`, clicável), `InfoDica` (ícone (i) com balão; é onde vão os textos explicativos, nunca dentro do cartão), `Selo`, `Segmentado`, `Medidor`, `Anel`, `Modal`, `Vazio`, `Recolhivel`, `Esqueleto`; gráficos em `graficos.jsx` (barras empilhadas, linhas, rosca, barrinha de 7 dias); campos de filtro em `campos.jsx`.

**Telas** (o menu tem os grupos Workspace e Operações):
- **Visão geral:** números do topo (pendências por severidade, Trello, alertas, uso 5 h e semanal, eventos de hoje), atividade de 7 dias por agente, resultados de 7 dias, resumo da Prospecção, último evento de cada agente e atividade recente.
- **Pendências:** números no topo (abertas, por severidade, respondidas, fechadas, a mais antiga; clicar filtra), lista, a pendência e a **resposta**: opção (a recomendada vem marcada) + comentário, Ctrl+Enter envia (`POST /api/pendencias/<id>/responder`). A resposta fica gravada na pendência e vai ao terminal do Cérebro; depois a próxima aberta já aparece.
- **Log:** cartões por resultado no topo (clicar filtra), busca (atalho "/"), período em botões, agentes e projetos como chips com contagem, tipo, "só o que precisa de mim", testes e filtros ativos com x; tabela com 50 por página.
- **Modal do evento** (clique ou Enter na linha): pedido, direção, passos, comandos e validação; ← (mais recente) e → (mais antigo) seguem a tabela filtrada.
- **Trello:** números do quadro, matriz projeto × status, evolução, cartões abertos (problemas como linhas compactas sob o título) e consistência (decisão, mecânicos, mudanças, RST).
- **Agentes:** um cartão resumido por agente (último evento, eventos hoje, fluxos abertos, consumo, 7 dias) e a ficha completa num modal (← → trocam de agente), mais resultados de 7 dias e o log bruto de cada um.
- **Uso:** plano (5 h e semanal, com reinício), participação por agente em três períodos e a tabela de tokens.
- **Prospecção** (grupo Operações): ver a seção Prospecção.

Consulta `/api/estado` a cada 20 s; a tela, os filtros, o modal e o que está aberto continuam como estavam. Se o servidor não responder, uma faixa vermelha avisa e a tela fica com a última leitura boa. Todo texto da API entra como texto (o Preact nunca monta HTML a partir de texto); `href` só para `https://trello.com/...`.

**Mexer na página:**
```
cd painel/ui
npm run dev      # http://127.0.0.1:5173, com /api apontando para o painel real (4777); ?mock=1 usa os dados de teste
npm run build    # compila e grava ../index.html (scripts/publicar.js junta tudo num arquivo só)
```
Depois do build, a página nova aparece no próximo carregamento (o servidor lê o `index.html` a cada pedido); reinicie o servidor só quando mudar o `servidor.js` ou os `api-*.js`.

### Modo de teste (`?mock=1`)

Para mexer na página sem servidor nem dados reais: `node painel/testes/servir-mock.js` (porta 4795; aceita 4790–4799) e abra `http://127.0.0.1:4795/?mock=1`. A página lê `testes/mock-estado.json` (resposta de `/api/estado`) e `testes/mock-detalhes.json` (eventos completos, comandos brutos e fluxos) e imita `/api/eventos`, `/api/evento/<id>` e `/api/fluxo/<id>` no próprio navegador. Uma faixa azul avisa que os dados são fictícios. `testes/gerar-mock.js` regrava os dois arquivos. Em produção (sem `?mock=1`) nada disso é usado, e o servidor real nem serve `/testes/...` (404).

Para ver a página com o **servidor de verdade** sobre os mesmos dados: `node testes/montar-raiz-mock.js [pasta em testes/tmp] [--hostil]` monta uma raiz falsa de `_maestro/` e imprime a linha para subir o `servidor.js` nela (porta de teste, relógio fixo, coletor desligado). `--hostil` acrescenta evento, pendência e cartão com HTML e `javascript:` para conferir que tudo aparece como texto.

Exemplo completo (Git Bash), da raiz do repositório: `node painel/testes/montar-raiz-mock.js` e depois `R=painel/testes/tmp/raiz-mock; MAESTRO_DIR=$R MAESTRI_DATA_DIR=$R/maestri CLAUDE_CONFIG_DIR=$R/claude PAINEL_AGORA=2026-10-09T10:24:30-03:00 PAINEL_COLETOR=0 node painel/servidor.js --porta 4793`; derrube com Ctrl+C (ou `taskkill //PID <pid> //F`; como o `taskkill /F` não deixa o servidor se despedir, o `estado/painel.pid` da raiz falsa fica para trás, e o próximo início o regrava).

## Prospecção (tela do app, `#prospeccao`)

A operação de prospecção por WhatsApp (leads, chips, fila e conversas tocadas por agentes) é uma tela do app: item **Prospecção** do grupo **Operações** do menu. Fonte em `ui/src/telas/Prospeccao.jsx`, `ProspeccaoLead.jsx` (o lead aberto) e `ProspeccaoComum.jsx`, CSS em `ui/src/estilo/prospeccao.css`. Abra `http://127.0.0.1:4777/#prospeccao` (sub-aba Captação: `#prospeccao/captacao`). O endereço antigo `http://127.0.0.1:4777/prospeccao` responde **302** para `/#prospeccao`, então links e portais que apontam para ele continuam funcionando. Para mudar a tela, edite a fonte em `ui/` e rode o build (seção "A página"); o `prospeccao.html` não é mais a tela.

**Página antiga.** O `painel/prospeccao.html` fica em `GET /prospeccao/antiga`, com a CSP própria (`CSP_PROSPECCAO`, a única que libera a fonte do Google), por compatibilidade. Não recebe mais mudanças.

**Leitura.** O App lê `/api/prospeccao/estado` ao abrir a tela (se a última leitura tiver mais de 30 s), a cada 30 s enquanto ela está aberta e quando a aba do navegador volta a ficar visível. A Visão geral relê o resumo da Prospecção junto com o estado, no máximo a cada 30 s. Se o servidor não responder, a tela continua com a última leitura boa ("Sem resposta · mostrando a leitura das HH:MM"); sem nenhuma leitura, mostra o motivo e tenta de novo a cada 30 s.

**Sub-abas.**
- **Barra do topo:** as duas sub-abas, os selos (modo teste, operação ligada ou desligada, qualificador ou captador desligado, sem `operacao.json`, janela de abordagem aberta ou fechada), a hora da leitura e a idade do sinal da vigia.
- **Qualificação** (`#prospeccao`): números do topo (leads hoje, respostas, qualificados, reuniões, WhatsApp ativos); Funil (kanban por etapa, com as saídas e filtros de segmento, chip, temperatura e origem); Para você agora (reuniões nas próximas 48 h, quentes sem reunião, passados para você); WhatsApp (situação de cada chip). Entram os leads do qualificador, de `READY_FOR_APPROACH` em diante, mais as saídas dele (`sem_resposta`, `perdido`, `desqualificado`). A fila aparece na coluna Novo.
- **Captação** (`#prospeccao/captacao`): descobertos e investigados hoje, aprovados 60+, descartados, prontos na fila e dias de fila; Candidatos (tabela pela ordem da fila); Aprovados por faixa; Score alto sem contato (os `QUALIFIED`); Serper hoje. Entra tudo que tem `origem: "captador"` ou score. Investigados hoje conta o `avaliado_em` de hoje; lead sem esse campo conta quando tem score, ainda está nas etapas do captador e foi alterado hoje.
- **Lead aberto** (clique no cartão ou na linha): o lead completo (`GET /api/prospeccao/lead/<id>`), com histórico, e os botões **Assumir conversa** e **Devolver ao agente**.

**Dados.** O `api-prospeccao.js` lê `estado/prospeccao/` só pela `bin/prospeccao/lib_prospeccao.js` (fila, chips efetivos, sinais da vigia, envios do dia, janelas), sem duplicar regra. O `leads.json` é lido uma vez por requisição. A lib calcula caminhos pelo `MAESTRO_DIR`: o servidor aponta essa variável para a própria raiz só durante a leitura (tudo síncrono) e a devolve em seguida. A leitura nunca grava: sem `operacao.json`, valem os padrões do contrato, e o arquivo não é criado. Se a lib não carregar, a API responde 503 com o motivo; o resto do painel continua funcionando.

**Assumir e devolver.** Os POST usam a mesma guarda dos outros: Host, `X-Painel: 1`, `Origin` do próprio painel e corpo JSON de até 16 KB. Eles rodam o comando canônico, sem shell e com `MAESTRO_DIR` da raiz do servidor:
- `leads.js humano --lead <id> --motivo "O dono assumiu a conversa pelo painel" --por painel` e, em seguida, `leads.js humano-notificado --lead <id>`. Quem assumiu foi o próprio dono, então nenhum aviso fica pendente para o WhatsApp dele.
- `leads.js devolver --lead <id>`.

Respostas: saída 1 do comando vira 409 (recusa por regra) e saída 2 vira 400. Lead inexistente dá 404 e `lead_id` fora do formato dá 400. Com o lead nas mãos do humano, o `registrar` e o `pode-enviar` do qualificador recusam qualquer envio.

**`/api/prospeccao/estado`** traz:
- `gerado_em`;
- `operacao`: `existe`, `qualificador_ativo`, `captador_ativo`, `modo_teste`, `numeros_teste` (só a quantidade), `limite_diario_por_chip` e `janela` (abordagem e resposta abertas agora);
- `vigia`: `atualizado_em` e `idade_s`;
- `chips[]`: status efetivo, `motivo_pausa`, `pausado_ate`, `conectado`, `nao_lidas`, frescor do sinal, `erro_vigia`, `abordagens_hoje`, `mensagens_hoje`, `limite`, `pode_abordar_agora` e `motivo`;
- `contagens`: total, `por_etapa` e `por_status`;
- `qualificacao`:
  - `kpis`: `leads_hoje` (abordados hoje), `novos_hoje`, `respostas_pct` (dos abordados, quantos já escreveram), `qualificados`, `reunioes_marcadas`, `reunioes_48h`, `chips_ativos`, `chips_total`;
  - `kanban`: cada etapa com `{total, leads}`, até 200 cartões por etapa, com quem está com o humano primeiro e depois por nota;
  - `para_voce`: `reunioes_48h`, `quentes_sem_reuniao` e `com_humano`;
- `prospeccao`:
  - `kpis`: `descobertos_hoje`, `investigados_hoje`, `aprovados` e `aprovados_hoje`, `descartados` e `descartados_hoje`, `faixas` 60+/70+/80+/90+, `chips_ativos`, `capacidade_diaria`, `fila`, `fila_minima`, `dias_fila` e `dias_minimos`;
  - `fila_por_faixa`;
  - `tabela`: até 300 leads, pela ordem da fila;
  - `sem_contato`: os QUALIFIED;
  - `serper`: uso de hoje e `tem_chave`. O servidor só confere se o arquivo existe e nunca lê a chave.

Nada sensível sai na API: nem a chave, nem o WhatsApp do humano responsável, nem os números de teste ou dos chips.

**Visual e segurança.** A tela usa os componentes e a identidade do app (seção "A página"): nada externo, Manrope embutida, ícones Lucide, sem emoji e sem gradiente. Todo texto da API entra como texto (o Preact nunca monta HTML a partir de texto), e o link de reunião só vira link se for `https://meet.google.com/...`.

**Modo de teste.** Com `?mock=1` (`testes/servir-mock.js`), a tela lê `testes/mock-prospeccao.json`, gerado por `testes/gerar-mock-prospeccao.js` (que chama o próprio `api-prospeccao.js` numa raiz falsa em `testes/tmp/`), e imita estado, lead, assumir e devolver só na memória da página.

## De onde vem cada dado

| No painel | Arquivo (em `_maestro/`) | Quem grava |
|---|---|---|
| agentes, cores, modelo, nível, skills | `registro/agentes.json` | Cérebro |
| tabela de log, modal, últimos eventos | `logs/eventos/AAAA-MM.jsonl` (`/api/estado` lê os 2 meses mais recentes; filtros e fluxos leem todos) | `bin/registrar.js` |
| comandos brutos, saúde dos hooks | `logs/bruto/<agente>/AAAA-MM-DD.jsonl` (e `.jsonl.gz`) | `bin/hook_log.js` (hooks do Claude Code) |
| pendências do dono | `estado/pendencias.json` | `bin/pendencia.js` |
| título do fluxo | `estado/contador-fluxos.json` | `registrar novo-fluxo` |
| Trello: números, cartões, auditoria, RST, gráfico | `estado/trello/resumo.json`, `rst.md`, `serie.jsonl` | Coordenador do Trello (skill trello-leitura) |
| uso do Claude | `estado/uso.json` | `bin/coletar_uso.js` |
| prospecção: leads, chips, operação, opt-out | `estado/prospeccao/leads.json`, `chips.json`, `operacao.json`, `optout.json` | captador e qualificador, pelos CLIs de `bin/prospeccao/` |
| prospecção: não lidas e conexão | `estado/prospeccao/sinais.json` | `bin/prospeccao/vigia-whatsapp.js` |
| prospecção: envios de hoje, uso do Serper | `estado/prospeccao/envios.jsonl`, `serper-chamadas.jsonl` | `leads.js registrar`, `serper.js` |
| % do plano (5 h e semanal) | `~/.maestri/usage/providers/.status.json` (via `uso.json`) | o próprio Maestri |
| consumo por agente | transcrições `~/.claude/projects/…`, atribuídas por `estado/sessoes/<session_id>.json` (via `uso.json`) | Claude Code + hook (`bin/hook_log.js`) |

A leitura é tolerante: arquivo ausente vira `null` ou lista vazia, linha JSONL quebrada é ignorada (e contada em `avisos`), linha final ainda sendo escrita fica para a próxima leitura, e arquivo preso por outro processo (EPERM/EBUSY no Windows) é lido de novo em seguida. Os JSONL são lidos de forma incremental (só os bytes novos), então a página continua rápida com dezenas de milhares de eventos.

## Saúde (selo do cabeçalho)

- **Trello:** amarelo se a última leitura passou de 2 × o intervalo da rotina (120 min), vermelho acima de 4 × (240 min), pela idade real. Como a rotina só roda de 8 às 22, de manhã cedo o selo fica vermelho até a primeira leitura do dia: é o comportamento esperado. Quem preferir descontar a noite pode subir com `PAINEL_TRELLO_JANELA=8-22` (só conta o tempo dentro do horário das leituras; o motivo mostra as duas idades, ex.: "Trello lido há 12 h 50 min, 2 h 50 min no horário das leituras"); isso é opcional. `saude.trello_idade_min` é sempre a idade real. Trello nunca lido também é amarelo.
- **Hooks:** amarelo se algum agente com `status: "ativo"` não tem log bruto há mais de 24 h (ou nunca teve).
- **Arquivos de estado ilegíveis** (`agentes.json`, `pendencias.json`, `resumo.json`): amarelo.
- `saude.motivos` traz cada motivo em texto curto; `saude.hooks` lista o último log bruto de cada agente (inclusive pastas `desconhecido-*`; pastas que começam com `_` ou `.`, como `_reatribuido-…`, são arquivo morto e ficam de fora). `wire` é sempre `false` (reservado para uma fase futura).

## Uso do Claude

Duas medidas separadas, sempre com a fonte indicada:

1. **Plano (conta inteira):** % da janela de 5 h e da semanal, horário de reset e idade do dado, lidos do `.status.json` do Maestri (o mesmo dos anéis). O Maestri só atualiza esse arquivo a cada 5 min com os anéis visíveis (mais devagar em segundo plano), por isso o painel mostra a idade. Se a janela já reiniciou depois da última leitura do Maestri, o % fica vazio com o motivo (o valor antigo enganaria).
2. **Participação de cada agente:** tokens das transcrições do Claude Code, atribuídas pelo dono da sessão em `estado/sessoes/`. Cada `message.id` conta uma vez, com a última linha (nos subagentes a primeira linha traz uso parcial). Sessão sem agente não entra.

`consumo relativo = entrada + 5 × saída + 1,25 × escrita de cache + 0,1 × leitura de cache`; `% do consumo` = participação no período; `% estimado do plano` = % do consumo × % do plano da janela correspondente (5 h → janela de 5 h; 7 dias → semanal; "hoje" não tem). Períodos: `janela_5h` (de reset − 5 h até agora; sem reset válido, as últimas 5 h), `hoje` (desde 00:00 em São Paulo) e `7d`. No `7d`, as barras mostram os 7 dias corridos, mas o % estimado do plano usa a participação de cada agente na **semana do plano** (de reset semanal − 7 dias até agora; `periodos["7d"].base_plano` e `pct_consumo_semana_plano`), que é a mesma base do % semanal do Maestri; sem reset semanal válido, usa os 7 dias corridos (`base_plano: null`). A nota "o % por agente é estimado; o % do plano vem do Maestri/Claude" vai junto no `uso.json`.

Coletor pela linha de comando (não precisa do servidor):

```
node bin/coletar_uso.js            # resumo legível e grava estado/uso.json
node bin/coletar_uso.js --json     # imprime o uso.json
node bin/coletar_uso.js --sem-gravar
```

A leitura é incremental: `estado/uso-cache.json` guarda o ponto já lido de cada transcrição e o último uso de cada mensagem (só dos últimos 8 dias). Apagar esse arquivo é seguro: a próxima rodada relê tudo.

## Rotinas: `janela-horario.js`

Para o `--pre-run` das rotinas do Maestri: sai 0 dentro da janela (horário de São Paulo) e 1 fora, sem escrever nada no stdout.

```
node bin/janela-horario.js 8 22
```

O fim é exclusivo (`8 22` aceita de 08:00 a 21:59; use `24` para ir até 23:59), aceita minutos (`8:30`) e janela que vira a noite (`22 6`). Argumento inválido sai 2 com a mensagem no stderr.

## Variáveis de ambiente

| Variável | Padrão | Para quê |
|---|---|---|
| `PAINEL_PORTA` | 4777 | porta (o `--porta` vale mais) |
| `MAESTRO_DIR` | a pasta acima de `painel/` (a raiz do repositório, que faz o papel de `_maestro`) | raiz dos dados (os testes apontam para `painel/testes/tmp/`) |
| `MAESTRI_DATA_DIR` | `~/.maestri` | onde está `usage/providers/.status.json` (o Maestri já define nos terminais dele) |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | transcrições de sessões sem `transcript_path` |
| `PAINEL_TRELLO_INTERVALO_MIN` | 60 | intervalo da rotina de leitura do Trello (saúde: 2× e 4×) |
| `PAINEL_TRELLO_JANELA` | `0-24` | opcional: `8-22` conta só o horário das leituras na saúde do Trello |
| `PAINEL_COLETOR` | (ligado) | `0` desliga o coletor automático (o botão Recalcular continua funcionando) |
| `PAINEL_INDEX`, `PAINEL_PROSPECCAO`, `PAINEL_AGORA` | | só para testes: outro `index.html`, outro `prospeccao.html` e relógio fixo (`MAESTRO_AGORA` também vale) |
| `PAINEL_AVISAR_CEREBRO` | automático | aviso ao Cérebro quando o dono responde uma pendência pelo painel: `0` desliga, `1` liga; sem a variável, liga só dentro de um terminal do Maestri (`MAESTRI_TERMINAL_ID`) e com relógio de verdade. `/api/estado` → `respostas` diz se está ligado e por quê |
| `PAINEL_MAESTRI_CLI` | `MAESTRI_CLI` ou `maestri` | executável usado no aviso (os testes apontam para um script falso que só grava os argumentos) |

## Diagnóstico

- **Selo amarelo ou vermelho:** passe o mouse no selo; cada motivo diz o que olhar. O mesmo texto está em `saude.motivos` de `/api/estado`.
- **"Trello lido há …":** a rotina "Trello · leitura" do Coordenador não rodou (Maestri fechado, rotina pausada, Coordenador ocupado ou com erro). Confira a rotina em Arquivo → Rotinas e o último evento do Coordenador; para ler agora, peça ao Cérebro. O horário da leitura está em `estado/trello/resumo.json` (`coletado_em`).
- **"… nenhum log bruto ainda (hooks instalados?)" ou "sem log bruto há …":** os hooks não estão gravando para aquele agente. Confira se os hooks do Claude Code chamam `bin/hook_log.js` e se há arquivo do dia em `logs/bruto/<agente>/`. Se os comandos estão caindo numa pasta `desconhecido-<id>`, o `terminal_id` do agente em `registro/agentes.json` está errado ou vazio. Um agente parado de propósito pode ficar sem log: troque o `status` dele para algo diferente de `ativo`.
- **Uso do plano "indisponível":** o motivo aparece no KPI (`kpis.uso.motivo`). Em geral: o uso dos agentes está desligado no Maestri (Configurações → Agentes → Uso), os anéis não estão visíveis, ou a última consulta do Maestri falhou. Confira `~/.maestri/usage/providers/.status.json` (`state`, `error`, `lastSuccessAt`). Dado velho aparece pela idade (`kpis.uso.idade_min`).
- **Consumo por agente zerado:** não há arquivo de sessão com dono em `estado/sessoes/` (hooks ainda não instalados ou sessão iniciada antes deles). `uso.json` → `coleta` mostra quantas sessões e transcrições foram lidas e quantas ficaram sem dono.
- **Botão Recalcular não muda nada:** o coletor só relê o que mudou; se o plano estiver indisponível, o motivo continua o mesmo até o Maestri gravar de novo. Erros do coletor aparecem no terminal do servidor e em `coletor.ultima`.
- **"a porta 4777 já está em uso":** já existe um painel rodando (veja `estado/painel.pid`) ou outro programa na porta: `netstat -ano | findstr :4777` mostra o PID.
- **Página com "arquivo do painel não foi encontrado" (503):** falta o `painel/index.html`.
- **Linhas ignoradas:** `avisos` de `/api/estado` lista arquivos com linhas JSONL ilegíveis.
- **Eventos de teste:** eventos e pendências com `teste: true` ficam fora dos KPIs e da tabela; o filtro "mostrar testes" (`incluir_testes=1`) traz os eventos.

## Testes

```
node painel/testes/rodar-todos.js
node painel/testes/rodar-todos.js servidor   # só os arquivos com "servidor" no nome
```

- `teste-coletor.js`: transcrições falsas (deduplicação pela última linha, subagentes, sessão sem dono, cache incremental, arquivo crescendo, arquivo trocado, plano indisponível, janela reiniciada, % do plano no 7d pela semana do plano, CLI).
- `teste-servidor.js`: raiz falsa realista numa porta de 4790 a 4799 (cada rota, filtros, modal, Host forjado → 403, POST sem `X-Painel` → 403, caminhos estranhos → 404, métodos errados → 405, leitura tolerante, porta ocupada, PID, anti-iframe, pedido inicial pelo prompt sem `fluxo_id`, vizinhos só com id válido, índice do log bruto, fluxo longo, itens null no estado).
- `teste-desempenho.js`: 50 mil eventos e log bruto grande e um fluxo aberto há 31 dias, cuja 2ª consulta usa o índice sem reler o log (`TESTE_PESADO=1` multiplica o log bruto).
- `teste-janela.js`: `janela-horario.js`.
- `teste-pendencias.js`: resposta de pendência pelo painel numa raiz falsa, com um `maestri` falso (opção + comentário, só texto, 409 na segunda resposta e em pendência fechada, 400/404, sem `X-Painel` → 403, GET → 405, aviso desligado, mensagem ao Cérebro numa linha só, sem barra invertida nem aspas retas).
- `teste-index.js`: a página sem navegador. No build: arquivo único (fonte embutida, `url()` só `data:`, nenhuma URL além do Trello e dos namespaces XML do Preact), script compila, só rotas do contrato. Na fonte (`ui/src`): nenhum `innerHTML`/`dangerouslySetInnerHTML`/`eval`, `href` só via `urlTrello` ou `linkMeet`, intervalos e fuso do contrato. Mais o cenário do mock e o servidor real numa raiz montada do mock com dados hostis (campos que a página lê, filtros, modal, 404, POST sem `X-Painel` → 403, Recalcular, `/api/cerebro` → 501). Rode depois de cada `npm run build`.

- `teste-prospeccao.js` (14 casos):
  - **servidor real numa raiz falsa:** `/prospeccao` → 302 para `/#prospeccao` (com link no corpo); `/prospeccao/antiga` com CSP da fonte do Google, anti-iframe e no-store (`/prospeccao/`, `/prospeccao/antiga/` e `/prospeccao.html` → 404); o estado com KPIs, kanban, chips, fila e Serper; nada sensível na resposta; o lead completo; 404 e ids estranhos; Host forjado → 403 e métodos errados → 405;
  - **POST:** sem `X-Painel` ou com `Origin` de fora → 403; corpo inválido → 400; lead inexistente → 404; corpo grande → 413; assumir e devolver alteram o banco temporário; devolver de novo → 409;
  - **estado real:** `estado/prospeccao` não é tocado;
  - **em processo:** banco vazio, banco com 6000 leads (resposta enxuta) e ambiente restaurado;
  - **página antiga (`prospeccao.html`):** sem emoji, só as cores da identidade visual, Manrope 300/400, nada de `innerHTML`, script compila;
  - **app:** a Prospecção é tela do menu no grupo Operações (fonte em `ui/src`), o menu não tem link para a página separada, a tela tem os textos esperados, sem `innerHTML`/`eval`, link de reunião só `https://meet.google.com`, e o `index.html` publicado leva à Prospecção.

Tudo é gravado em `painel/testes/tmp/<teste>-<pid>/` e apagado no fim (`MANTER_TMP=1` guarda para inspeção). Os servidores de teste são derrubados pelo PID que eles mesmos imprimem.
