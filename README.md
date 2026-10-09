# painel-maestro

Painel web local para acompanhar um workspace multiagente montado no app Maestri com agentes Claude Code. Um servidor Node.js sem dependências lê os arquivos que os agentes gravam (log de eventos, fila de pendências, uso do plano) e mostra tudo numa página só, em `http://127.0.0.1`.

Este repositório traz **só o painel** e os scripts de linha de comando que gravam os dados que ele lê. Os agentes em si (papéis, prompts, rotinas) não estão aqui: cada um monta os seus. O método que eles seguem vem como modelo para adaptar (veja [Skills e protocolos do workspace](#skills-e-protocolos-do-workspace)).

## A ideia

No workspace, um agente principal, o **Cérebro Principal**, recebe os pedidos do dono. Ele não executa trabalho de domínio: entende o pedido, decide quem atende e delega a sub-agentes especializados, cada um com o seu domínio (por exemplo, um **Coordenador de Dependências** que audita os pacotes dos projetos). O Cérebro acompanha até a resposta, valida e devolve o resultado ao dono.

Todo pedido abre um **fluxo** (`F-AAAAMMDD-NNNN`), e tudo que acontece nele vira um **evento** num log: quem fez, de onde veio o pedido, o tipo, o resultado e a **direção**, isto é, o caminho que o agente tomou e por quê. Em paralelo, hooks do Claude Code gravam o **log bruto** de cada agente (prompts, comandos, ferramentas usadas), que o painel liga ao evento certo pelo id do fluxo ou pela janela de tempo.

As decisões que só o dono pode tomar entram numa **fila de pendências**, sempre com contexto, opções e uma recomendação. O dono responde pelo próprio painel, e a resposta fica gravada na pendência e vira evento no fluxo de origem.

O painel junta tudo isso num lugar só e não usa IA nem gasta tokens: ele só lê arquivos.

## Telas

O menu tem um grupo, Workspace (fonte em `painel/ui/src/dados/contexto.js`):

- **Visão geral:** números do topo (pendências por severidade, uso do plano, eventos de hoje), atividade e resultados de 7 dias por agente, último evento de cada agente e atividade recente. O cabeçalho tem um **selo de saúde** (verde, amarelo ou vermelho) com os motivos: hooks parados, arquivos ilegíveis.
- **Pendências:** a fila do dono, com filtros por severidade e status; cada pendência mostra contexto, opções e recomendação, e o dono responde ali mesmo (opção + comentário, Ctrl+Enter envia).
- **Log:** a tabela de eventos com busca, período, chips de agente e projeto, tipo, resultado e "só o que precisa de mim". Clicar numa linha abre o **modal do evento**: o pedido inicial, a direção, os passos, os comandos brutos ligados a ele e a sequência do fluxo.
- **Agentes:** um cartão por agente (último evento, eventos de hoje, fluxos abertos, consumo) e a ficha completa num modal, com o log bruto de cada um.
- **Uso:** o plano do Claude (janela de 5 h e semanal, com o horário de reinício) e a participação de cada agente no consumo de tokens.

A página se atualiza sozinha a cada 20 segundos.

## Demonstração em 1 minuto

Precisa só do Node.js. A página compilada (`painel/index.html`) já vem no repositório, então não é preciso instalar nada.

```
git clone <url-do-repositorio> painel-maestro
cd painel-maestro
npm run demo
```

Abra **http://127.0.0.1:4795/?mock=1**. O `?mock=1` faz a página ler dados fictícios de `painel/testes/mock-*.json` (um workspace "Exemplo" com dois agentes, pendências, eventos e comandos brutos); uma faixa azul avisa que são dados de teste. Para parar, Ctrl+C.

O servidor da demonstração aceita só as portas 4790 a 4799 (padrão 4795). Outra porta: `npm run demo -- 4794`.

### O servidor de verdade sobre dados de exemplo

Para ver o `servidor.js` real (a API inteira, com os filtros e o modal calculados no servidor) sem dados seus, monte uma raiz falsa a partir dos mesmos mocks. No Git Bash, Linux ou macOS:

```
node painel/testes/montar-raiz-mock.js
R=painel/testes/tmp/raiz-mock
MAESTRO_DIR=$R MAESTRI_DATA_DIR=$R/maestri CLAUDE_CONFIG_DIR=$R/claude \
  PAINEL_AGORA=2026-10-09T10:24:30-03:00 PAINEL_COLETOR=0 PAINEL_AVISAR_CEREBRO=0 \
  node painel/servidor.js --porta 4793
```

Abra **http://127.0.0.1:4793** (sem `?mock=1`). O `PAINEL_AGORA` fixa o relógio no momento do cenário de exemplo e o `PAINEL_COLETOR=0` desliga o coletor de uso. Ctrl+C para parar. A pasta `painel/testes/tmp/` pode ser apagada depois.

## Ligar a dados reais

### Onde ficam os dados

Tudo é lido de uma pasta raiz, o `MAESTRO_DIR`. Sem a variável, a raiz é **a própria pasta do repositório** (a pasta acima de `painel/` e de `bin/`). O jeito mais simples é clonar o repositório como `_maestro/` dentro da pasta do seu workspace:

```
<seu-workspace>/
  _maestro/            ← este repositório (MAESTRO_DIR)
    bin/  painel/
    registro/agentes.json
    logs/  estado/     ← criados pelos scripts e pelos hooks
```

Os dados (`registro/`, `logs/`, `estado/`, `.segredos/`) ficam fora do git pelo `.gitignore`. Se preferir os dados em outro lugar, aponte `MAESTRO_DIR` para lá, no servidor e no ambiente dos agentes.

| No painel | Arquivo (dentro do `MAESTRO_DIR`) | Quem grava |
|---|---|---|
| agentes, cores, modelo, skills | `registro/agentes.json` | você (à mão ou por um agente) |
| log de eventos, fluxos, modal | `logs/eventos/AAAA-MM.jsonl` | `bin/registrar.js` |
| títulos dos fluxos | `estado/contador-fluxos.json` | `bin/registrar.js novo-fluxo` |
| comandos brutos, saúde dos hooks | `logs/bruto/<agente>/AAAA-MM-DD.jsonl` | `bin/hook_log.js` (hook do Claude Code) |
| pendências do dono | `estado/pendencias.json` | `bin/pendencia.js` (e o painel, ao responder) |
| uso do Claude | `estado/uso.json` | `bin/coletar_uso.js` (o servidor roda sozinho) |

Arquivo ausente não quebra nada: a parte correspondente aparece vazia, com o motivo. O formato completo de cada arquivo está nos mocks (`painel/testes/mock-estado.json` e `mock-detalhes.json`) e o `painel/testes/montar-raiz-mock.js` mostra em que arquivo cada parte vai. A documentação técnica do servidor (rotas, filtros, saúde, uso, variáveis) está em [`painel/README.md`](painel/README.md).

### 1. Cadastre os agentes

`registro/agentes.json`, no mínimo:

```json
{
  "workspace": { "id": null, "nome": "Meu workspace", "raiz": null },
  "agentes": [
    {
      "slug": "cerebro", "nome": "Cérebro Principal", "tipo": "maestro", "cor": "#E8C547",
      "responsabilidade": "Recebe os pedidos do dono, roteia e valida",
      "terminal_id": null, "diretorios": [], "modelo": "claude-opus-5-5", "nivel": "xhigh",
      "conectado_a": ["coordenador"], "skills": [], "status": "ativo"
    },
    {
      "slug": "coordenador", "nome": "Coordenador de Dependências", "tipo": "sub-cerebro", "cor": "#4F6BFF",
      "responsabilidade": "Audita as dependências dos projetos",
      "terminal_id": null, "diretorios": [], "modelo": "claude-opus-5-5", "nivel": "high",
      "conectado_a": ["cerebro"], "skills": [], "status": "ativo"
    }
  ]
}
```

O hook descobre qual agente está rodando pelo `terminal_id` (o id do terminal no Maestri, que chega na variável `MAESTRI_TERMINAL_ID`) ou pelos `diretorios` (a pasta de trabalho do agente). O `workspace.id` é o id do workspace no Maestri (`MAESTRI_WORKSPACE_ID`); com ele preenchido, sessões de outros workspaces são ignoradas. Um agente com `status: "ativo"` e sem log bruto há mais de 24 h deixa o selo amarelo.

### 2. Registre eventos e pendências

Os agentes chamam estes comandos (as instruções de cada agente devem dizer quando):

```
node bin/registrar.js novo-fluxo --titulo "Auditar as dependências" --agente cerebro
node bin/registrar.js evento --agente cerebro --fluxo F-20261009-0001 --origem dono-direto \
  --tipo pedido-recebido --resumo "Pedido para auditar as dependências" --resultado em-andamento
node bin/registrar.js evento --agente cerebro --fluxo F-20261009-0001 --origem cerebro \
  --tipo delegacao --resumo "Pedi a auditoria ao Coordenador" --direcao "As dependências são do Coordenador" --resultado ok
node bin/pendencia.js abrir --agente cerebro --fluxo F-20261009-0001 --tipo decisao --severidade alta \
  --titulo "Remover o pacote antigo?" --contexto "..." --opcao "A: remover" --opcao "B: manter" \
  --recomendacao "A: nenhum arquivo importa o pacote há 30 dias"
```

Dentro de uma sessão do Claude Code com o hook instalado, `--agente` e `--fluxo` podem ser omitidos: o agente sai do cadastro e o fluxo, da sessão. Texto com aspas ou acentos vai melhor em JSON pela entrada padrão (`--json -`). Todas as opções: `node bin/registrar.js --help` e `node bin/pendencia.js --help`.

### 3. Instale o hook do Claude Code

O `bin/hook_log.js` lê o evento do hook pela entrada padrão e grava uma linha no log bruto do agente. Ele nunca escreve no stdout nem no stderr, sai sempre com 0, desiste em cerca de 1,5 s, trunca entradas e saídas e redige segredos. Exemplo para o `settings.json` do Claude Code (troque o caminho):

```json
{
  "hooks": {
    "SessionStart":       [{ "hooks": [{ "type": "command", "command": "node /caminho/para/_maestro/bin/hook_log.js" }] }],
    "UserPromptSubmit":   [{ "hooks": [{ "type": "command", "command": "node /caminho/para/_maestro/bin/hook_log.js" }] }],
    "PostToolUse":        [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /caminho/para/_maestro/bin/hook_log.js" }] }],
    "PostToolUseFailure": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /caminho/para/_maestro/bin/hook_log.js" }] }],
    "Stop":               [{ "hooks": [{ "type": "command", "command": "node /caminho/para/_maestro/bin/hook_log.js" }] }],
    "SubagentStop":       [{ "hooks": [{ "type": "command", "command": "node /caminho/para/_maestro/bin/hook_log.js" }] }],
    "SessionEnd":         [{ "hooks": [{ "type": "command", "command": "node /caminho/para/_maestro/bin/hook_log.js" }] }]
  }
}
```

O hook entende esses sete eventos; se a sua versão do Claude Code não tiver algum deles, deixe-o de fora. Ele só grava sessões do workspace: as que rodam dentro da pasta que contém o `MAESTRO_DIR` ou num terminal do Maestri com o mesmo `workspace.id`. As outras saem em poucos milissegundos, sem gravar nada. Ele também grava `estado/sessoes/<session_id>.json`, que é o que permite atribuir o consumo de tokens a cada agente.

### 4. Suba o painel

```
node painel/servidor.js            # ou: npm start
```

Abra **http://127.0.0.1:4777** (use `127.0.0.1`, não `localhost`). Outra porta: `--porta 4780` ou a variável `PAINEL_PORTA`. O servidor grava o PID em `estado/painel.pid` e roda o coletor de uso ao subir e a cada 5 minutos.

Sobre o uso do Claude:
- a **participação de cada agente** vem das transcrições locais do Claude Code (`~/.claude`, ou `CLAUDE_CONFIG_DIR`), só das sessões que o hook atribuiu a um agente;
- o **% do plano** (5 h e semanal) vem do arquivo que o Maestri grava em `~/.maestri/usage/providers/.status.json` (ou `MAESTRI_DATA_DIR`). Fora do Maestri, essa parte aparece como indisponível, com o motivo.

Quando o dono responde uma pendência pelo painel, o servidor pode avisar o Cérebro no terminal dele pela CLI do Maestri (`maestri ask`). Isso liga sozinho só quando o servidor roda dentro de um terminal do Maestri; `PAINEL_AVISAR_CEREBRO=0` desliga e `1` força.

## Scripts de `bin/`

Todos usam só a biblioteca padrão do Node e respeitam `MAESTRO_DIR`.

| Script | Para que serve |
|---|---|
| `registrar.js` | log semântico: `novo-fluxo`, `evento`, `ultimos`, `fluxo` |
| `pendencia.js` | fila de pendências do dono: `abrir`, `listar`, `mostrar`, `responder`, `resolver`, `cancelar` |
| `hook_log.js` | hook do Claude Code que grava o log bruto e o estado das sessões |
| `coletar_uso.js` | coletor de uso do Claude (`--json`, `--sem-gravar`); o servidor já o chama |
| `janela-horario.js` | sai 0 dentro de uma faixa de horário e 1 fora (`node bin/janela-horario.js 8 22`), útil como pré-condição de rotinas agendadas |
| `lib_maestro.js` | funções comuns: caminhos, datas no fuso de São Paulo, trava entre processos, gravação atômica de JSON, JSONL, redação de segredos |

Quase todos aceitam `--help` (o `janela-horario.js` não: ele só recebe início e fim). Os horários e datas usam o fuso `America/Sao_Paulo`.

## Segurança

- O servidor escuta **só em 127.0.0.1**. O cabeçalho `Host` precisa ser `127.0.0.1:<porta>` ou `localhost:<porta>`; qualquer outro recebe 403 (proteção contra DNS rebinding).
- Todo `POST` exige o cabeçalho **`X-Painel: 1`** e, se vier `Origin`, ele precisa ser o próprio painel; senão, 403. Outra página aberta no navegador não consegue acionar o servidor. Os corpos JSON vão até 16 KB (acima disso, 413).
- Nenhum cabeçalho CORS. Só existem `/` e `/api/*`; nenhum arquivo é servido pelo nome (o resto é 404).
- Toda resposta leva `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` e `X-Frame-Options: DENY`. A página leva uma **Content-Security-Policy** que bloqueia qualquer recurso externo e impede que outro site a embuta num iframe.
- A página é um arquivo único (JS, CSS e fonte embutidos). Todo texto vindo da API entra como texto, nunca como HTML; a página não tem links para fora.
- **Sem dependências** no servidor e nos scripts: só a biblioteca padrão do Node. O servidor não faz nenhuma requisição para fora da máquina. As dependências npm (Preact, Vite, a fonte Manrope e os ícones Lucide) servem só para compilar a página.

Não exponha a porta do painel na rede: ele não tem login e foi feito para uso local.

## Compilar a página

A fonte da página fica em `painel/ui/` (Preact, compilado pelo Vite num HTML único). O resultado, `painel/index.html`, é versionado; só é preciso compilar se você mudar a fonte. O Vite 8 pede Node 20.19+ ou 22.12+.

```
cd painel/ui
npm ci
npm run build      # vite build + scripts/publicar.js, que grava ../index.html
npm run check      # confere o index.html: um único script, nada externo
npm run dev        # http://127.0.0.1:5173, com /api apontando para o painel em 127.0.0.1:4777
```

Da raiz do repositório, `npm run build` faz o mesmo que o `npm run build` dentro de `painel/ui` (depois do `npm ci` lá). Com `npm run dev`, abra `http://127.0.0.1:5173/?mock=1` para usar os dados de teste sem servidor. Depois de compilar, rode os testes. Como acrescentar uma tela nova está em [`painel/README.md`](painel/README.md#a-página-indexhtml-fonte-em-ui).

## Testes

```
npm test                                   # node painel/testes/rodar-todos.js
node painel/testes/rodar-todos.js servidor # só os arquivos com "servidor" no nome
```

Os testes não usam framework nem navegador. Cada arquivo monta uma raiz falsa em `painel/testes/tmp/` e aponta `MAESTRO_DIR`, `MAESTRI_DATA_DIR` e `CLAUDE_CONFIG_DIR` para ela, sobe servidores só nas portas 4790 a 4799 e apaga tudo no fim (`MANTER_TMP=1` guarda para inspeção). O teste das pendências usa uma CLI do Maestri falsa, que só grava os argumentos. São 6 arquivos: coletor de uso, desempenho (50 mil eventos e log bruto grande), página compilada, filtro de horário, pendências e servidor.

Para regerar os dados da demonstração: `node painel/testes/gerar-mock.js`.

## Estrutura

```
painel-maestro/
├── bin/                      scripts de linha de comando (só biblioteca padrão do Node)
│   ├── registrar.js          log de eventos e fluxos
│   ├── pendencia.js          fila de pendências do dono
│   ├── hook_log.js           hook do Claude Code → log bruto
│   ├── coletar_uso.js        uso do plano e tokens por agente
│   ├── janela-horario.js     filtro de horário para rotinas
│   └── lib_maestro.js        biblioteca comum
├── painel/
│   ├── servidor.js           servidor HTTP e API
│   ├── api-pendencias.js     resposta de pendência pelo painel
│   ├── index.html            a página compilada (não edite à mão)
│   ├── README.md             documentação técnica do servidor e da página
│   ├── ui/                   fonte da página (Preact + Vite)
│   │   ├── src/app/          casca, menu e topo
│   │   ├── src/telas/        uma tela por arquivo
│   │   ├── src/componentes/  cartões, KPIs, gráficos em SVG, modal
│   │   ├── src/dados/        API, modo de teste, consultas e formatação
│   │   ├── src/estilo/       CSS por tela
│   │   └── scripts/publicar.js  junta o build num HTML único
│   └── testes/               testes, mocks e servidores de demonstração
├── skills/
│   ├── cerebro/              orquestracao, pendencias, painel, onboarding-agente
│   └── compartilhadas/       protocolo-delegacao, registro-eventos
├── conhecimento/protocolos/  delegação, pendências, registro, autonomia
├── exemplos/                 CLAUDE.md (regra comum) e responsabilidade-cerebro.md
├── package.json
├── LICENSE
└── README.md
```

## Requisitos e limites

- Node.js 18 ou mais novo para o servidor e os scripts (desenvolvido e testado no Node 22); Node 20.19+ ou 22.12+ para compilar a página.
- Desenvolvido e testado no Windows. Os caminhos e a trava entre processos têm tratamento para outros sistemas, mas eles não foram testados.
- O painel só lê arquivos: quem mantém os dados em dia são os seus agentes.
- O botão de conversar com o Cérebro pelo painel ainda não existe (`POST /api/cerebro` responde 501).
- O painel saiu de um workspace maior. Alguns comentários do código citam scripts e documentos desse workspace que não vêm neste repositório: eles só produzem os arquivos que o painel lê, e o formato desses arquivos está descrito acima.

## Skills e protocolos do workspace

Além do painel, o repositório traz o método que os agentes seguem, em texto. São **modelos para adaptar**: copie, troque nomes, projetos e regras pelos do seu workspace e mantenha o que servir. Os caminhos citados são relativos à raiz do repositório (o `MAESTRO_DIR`); arquivos como `registro/agentes.md` e `registro/roteamento.md` são do workspace de quem usar e não vêm aqui.

- **`skills/cerebro/`**, skills do agente principal (Cérebro):
  - `orquestracao`: classificar cada pedido do dono, achar quem responde por ele, delegar, acompanhar, validar e responder (resultado, o que precisa do dono, detalhes);
  - `pendencias`: a fila de decisões do dono, do jeito de escrever (contexto, opções, recomendação) até devolver a decisão a quem pediu e fechar;
  - `painel`: manter este painel no ar e com dado fresco;
  - `onboarding-agente`: criar um sub-agente novo para um domínio e ligá-lo ao resto.
- **`skills/compartilhadas/`**, para todos os agentes:
  - `protocolo-delegacao`: os envelopes [PEDIDO], [RESPOSTA], [AVISO] e [COBRANÇA], o fluxo `F-AAAAMMDD-NNNN` e como mandar com `maestri ask` sem perder nem duplicar pedido;
  - `registro-eventos`: como gravar cada evento com `bin/registrar.js` (tipo, resumo, direção, resultado) e quando abrir pendência com `bin/pendencia.js`.
- **`conhecimento/protocolos/`**: as regras por trás das skills, em quatro arquivos: delegação, pendências, registro e autonomia (o que cada agente faz sozinho, o que propõe e o que é sempre do dono).
- **`exemplos/`**: `CLAUDE.md`, a regra comum de todos os agentes do workspace, e `responsabilidade-cerebro.md`, o papel do agente principal.

As skills seguem o formato de skill do Claude Code (pasta com `SKILL.md` e cabeçalho `name`/`description`). Para usá-las, copie ou ligue as pastas em `.claude/skills/` do workspace.

## Licença

[MIT](LICENSE).

**Terceiros** (embutidos no `painel/index.html` compilado):
- [Preact](https://preactjs.com) · licença MIT.
- [Lucide](https://lucide.dev) (`lucide-preact`, ícones) · licença ISC.
- Fonte [Manrope](https://github.com/sharanda/manrope) · SIL Open Font License 1.1 (Copyright 2019 The Manrope Project Authors).
