---
name: onboarding-agente
description: 'Cérebro Principal · Use para criar um sub-cérebro novo (agente permanente de um domínio ou projeto) ou para trazer para a arquitetura um terminal que já existe no canvas: ficha das 12 perguntas, pendência de aprovação, conhecimento e skills no MAESTRO_DIR, maestri role create, maestri recruit com o modelo e o esforço padrão do workspace, diálogo de confiança, maestri connect, exposição das skills, registro (agentes.json, roteamento, projetos, decisões), teste de identidade e primeiro pedido acompanhado.'
---

# Onboarding de agente (sub-cérebro novo)

**Resultado:** um agente novo, aprovado pelo dono, rodando com o modelo e o esforço padrão do workspace (neste exemplo, Opus 5.5 com janela de 1M e esforço xhigh), com responsabilidade, conhecimento e skills próprios, conectado a quem precisa, registrado em `registro/`, aparecendo no painel com o slug certo, que passou no teste de identidade e no primeiro pedido real.

Caminhos relativos à raiz deste repositório, o `MAESTRO_DIR` (por exemplo, `<raiz do workspace>/_maestro`); nas instruções dos agentes, escreva-os como caminho absoluto. Os arquivos de `registro/` (`agentes.json`, `agentes.md`, `roteamento.md`, `projetos.md`, `decisoes.md`, `fichas/`) não vêm no repositório: são do workspace de quem usar. Princípio: agente = domínio, não tarefa. Sintaxe da CLI: `maestri --help` e a skill `maestri-manager`.

## Quando usar
- O dono pediu um agente para um projeto ou domínio.
- Você notou os sinais e vai **propor**: domínio com conhecimento próprio extenso, ferramentas próprias (repositório, navegador logado, API) e demandas recorrentes.
- Trazer para a arquitetura um terminal que já existe no canvas e está fora do registro (confira com `node skills/cerebro/onboarding-agente/listar-terminais.js`: aparece como "NÃO REGISTRADO").

## Quando NÃO usar
- É só uma tarefa, ou o domínio já tem dono (`registro/roteamento.md`): delegue ao dono do domínio.
- Terminal temporário de apoio (pesquisa pontual): `maestri recruit` simples, sem ficha, dispensado no fim (decisão sua, registrada). Não entra no registro.
- Mudar responsabilidade de agente que já existe: é edição de role (reinicia o terminal; handoff + ok do dono), não onboarding.

## Pré-requisitos
- Nível 2: nada de recrutar antes do ok do dono (pendência respondida).
- Leia: `registro/agentes.md`, `registro/roteamento.md`, `registro/projetos.md` e uma ficha existente como modelo (por exemplo, `registro/fichas/coordenador-trello.md`).
- Fluxo próprio: `node bin/registrar.js novo-fluxo --titulo "Onboarding <Nome>"`.
- Defina com o dono: **nome no Maestri** (ex.: "Projeto Atlas"), **slug** (`projeto-<nome>` para projeto, `<dominio>` para domínio, minúsculo, sem acento: `projeto-atlas`), **diretório** de trabalho (se o dono indicar), portais e notas de que precisa.

## Passo a passo
### 1. Ficha das 12 perguntas (com o dono)
Escreva `registro/fichas/<slug>.md` no mesmo formato das fichas que já existem: tabela com 1. Domínio · 2. Responsabilidades · 3. Conhecimento interno · 4. Conhecimento externo · 5. Skills · 6. Ferramentas · 7. Coordena ou aciona · 8. Decide sozinho · 9. Escala · 10. Como valida · 11. Como registra · 12. Regras obrigatórias; depois "Configuração do terminal" (nome, responsabilidade, modelo `claude-opus-5-5[1m]`, nível xhigh, conectado a, diretório).
- Pergunte o que não está escrito; nunca invente domínio, regra, ferramenta ou autonomia. Respostas em aberto ficam marcadas "a definir pelo dono".
- Autonomia padrão de sub-cérebro novo: nível 1 só dentro de regras escritas do domínio; todo o resto escala.

### 2. Rascunho da responsabilidade
Escreva `registro/fichas/<slug>-responsabilidade.md` com a mesma estrutura das responsabilidades que já existem (veja `exemplos/responsabilidade-cerebro.md`): identidade e domínio em 2 frases · "Ao iniciar cada sessão" · Responsabilidades (por grupo) · Autonomia (o que faz e avisa; o que propõe e espera; o que é sempre do dono) · Como operar as ferramentas · Skills · Registro · Não faz.
Regras do texto:
- **Nenhuma barra invertida** (a CLI do Maestri transforma `\n` e `\t` em `ask` e `note`; por segurança, vale também para `role create`). Caminhos absolutos com barra normal, `<raiz do workspace>/...`.
- Comandos na forma canônica, com caminho absoluto: `node <raiz do workspace>/_maestro/bin/registrar.js ...` e `node <raiz do workspace>/_maestro/bin/pendencia.js abrir ...`.
- Primeiro item de "Ao iniciar cada sessão": `Leia <raiz do workspace>/CLAUDE.md (se não tiver sido carregado).` Obrigatório se o terminal for rodar fora da raiz do workspace (passo 6).
- Diga quem ele chama e por qual nome exato ("Cérebro Principal", "Coordenador do Trello"), que portal usa e que notas lê: a conexão não ensina nada ao agente.
- Inclua: demandas do Trello sempre via Coordenador do Trello; envelope [RESPOSTA]; [AVISO] ao Cérebro quando o dono falar direto e mudar algo.

### 3. Pendência de aprovação (nível 2)
```
node bin/pendencia.js abrir --fluxo F-AAAAMMDD-NNNN --severidade normal --tipo aprovacao --titulo "Criar o sub-cérebro <Nome>" --contexto "Domínio: <1 frase>. Faz sozinho: <o que é nível 1 para ele>; escala: <o que volta ao Cérebro ou ao dono>. Diretório: <pasta ou cwd padrão do role>. Liga com: <agentes, portais, notas>. Custo: <modelo e esforço>; cada turno gasta a janela de uso do plano. Detalhe (complemento): registro/fichas/<slug>.md e <slug>-responsabilidade.md." --opcao "A: aprovar como está" --opcao "B: aprovar com os ajustes que eu indicar" --opcao "C: não criar agora" --recomendacao "A, porque <sinal concreto: conhecimento próprio, ferramenta própria, demanda recorrente>."
```
O contexto tem de bastar para o dono decidir sem abrir a ficha (3 a 5 linhas: domínio, autonomia, diretório, conexões, custo); os caminhos vão só como complemento. Texto com aspas ou acento: mande por JSON (`--json -` ou `--json-arquivo`; skill `pendencias`). Apresente ao dono (skill `pendencias`). Ajustes pedidos: corrija os arquivos e mostre de novo. Só siga com o ok registrado (`pendencia.js responder`).

### 4. Conhecimento e skills do domínio
1. Conhecimento: `conhecimento/<dominio>/` (ou outra pasta que o dono indicar). Só o que foi dito ou está escrito.
2. Skills: `skills/<slug>/<nome-da-skill>/SKILL.md`, frontmatter:
   ```
   ---
   name: <nome-da-skill>
   description: <Nome do agente no Maestri> · <quando usar, em 1-2 frases>
   ---
   ```
   O dono no começo da descrição é obrigatório (todas as skills ficam visíveis para todos os agentes). O nome da skill não pode repetir o de outra (o destino das skills é uma pasta plana).
3. Exponha as skills ao Claude Code: cada pasta de skill precisa aparecer em `<raiz do workspace>/.claude/skills/<nome-da-skill>/` (por junção, link simbólico ou cópia). Este repositório não traz um instalador; se o seu workspace tiver um, rode-o em modo de simulação, depois de verdade, depois em modo de verificação, e confira que as skills novas aparecem como instaladas.

### 5. Criar a responsabilidade no Maestri
Git Bash:
```
maestri role create "<Nome>" "$(cat <raiz do workspace>/_maestro/registro/fichas/<slug>-responsabilidade.md)"
maestri role show "<Nome>"
```
PowerShell:
```
$p = Get-Content -Raw -Encoding utf8 "<raiz do workspace>/_maestro/registro/fichas/<slug>-responsabilidade.md"
maestri role create "<Nome>" $p
maestri role show "<Nome>"
```
- Confira no `role show`: acentos, aspas, quebras de linha, nenhum TAB no lugar de `\t`.
- A CLI **não escolhe cor nem ícone**: a cor sai da paleta pela quantidade de roles; a cor do agente no painel é a do `agentes.json`. Se quiser, o dono ajusta a cor no app.
- Nome único (sem diferenciar maiúsculas); escopo padrão `current` (só este workspace).

### 6. Recrutar o terminal
```
maestri recruit "<Nome>" --preset "Claude Code" --role "<Nome>" --command 'claude --model "claude-opus-5-5[1m]" --effort xhigh'
```
- Troque modelo e esforço pelo padrão do seu workspace. As aspas simples protegem o `[1m]` no Git Bash; a mesma linha funciona no PowerShell.
- Diretório do projeto indicado pelo dono: acrescente `--dir "<caminho do projeto>"` (a pasta precisa existir). O agente roda em `<dir>/.maestri/roles/<id>/`. **Atenção:** fora da raiz do workspace, o `CLAUDE.md` da raiz e as skills de `<raiz do workspace>/.claude/skills` **não** são ancestrais e não carregam. Então: a responsabilidade manda ler o `CLAUDE.md` da raiz (passo 2), e as skills precisam ser expostas também em `<dir>/.claude/skills` (como no passo 4.3, com esse destino).
  Guarde o destino extra na ficha ("Configuração do terminal") e confira os dois destinos sempre que mexer em skills. Isso grava dentro do projeto do dono: só com o ok dele e uma decisão nova em `registro/decisoes.md`.
- Agente em outro workspace: `--workspace "<Workspace>"`; ele passa a ser endereçado como `<Nome> @ <Workspace>`, e os hooks deste workspace não o registram (o hook sai quando o workspace é outro).
- O comando volta quando o terminal existe; o agente ainda está subindo. Espere uns segundos.

### 7. Diálogo de confiança da pasta
```
maestri check "<Nome>"
```
- Se a tela mostrar "Do you trust the files in this folder?" (provável no primeiro agente numa pasta nunca aceita; a confiança vale para a pasta e as de baixo e fica em `~/.claude.json`):
  - **Preferido:** peça ao dono para aceitar direto no terminal, no canvas.
  - **Alternativa:** leia a tela com `maestri check`. Se a opção de confiar não estiver destacada, mova com `maestri ask "<Nome>" --raw "\e[B"` (seta para baixo) e leia de novo. Depois mande Enter: `maestri ask "<Nome>" --raw "\n"`. Nunca mande teclas sem ter lido a tela.
- Confira de novo com `maestri check` até ver o Claude Code pronto (caixa de entrada vazia).

### 8. Conectar
O recruta já nasce ligado a você. Ligue o resto que a ficha pede:
```
maestri connect "<Nome>" "Coordenador do Trello"
maestri connect "<Nome>" "<portal>"
maestri connect "<Nome>" "<nota>"
maestri list
```
- Ligue ao Coordenador do Trello só se ele for receber ou consultar demandas do Trello.
- As duas pontas precisam estar na sua árvore (você, recruta direto, ou nota/portal ligado a um dos dois). Portal ou nota do canvas fora da árvore (ligado só a outro terminal) dá `No connection`: peça ao dono para ligar o cabo no canvas.
- Portal só liga a agente, nunca a nota.

### 9. Registrar o agente (antes do teste, para os logs já saírem com o slug)
1. Descubra `terminal_id` e a pasta do role (o `workspace.json` do Maestri é gravado a cada ~30 s):
   ```
   node skills/cerebro/onboarding-agente/listar-terminais.js --nome "<Nome>"
   ```
   Anote `terminal_id` e o `cwd` da linha "responsabilidade" (`.../.maestri/roles/<id-minúsculo>`).
2. `registro/agentes.json` (ferramenta Edit; mesmo formato das entradas que existem): `slug`, `nome`, `tipo: "sub-cerebro"`, `cor` (hex), `responsabilidade`, `terminal_id`, `diretorios: ["<cwd do role, barra normal>"]`, `modelo: "claude-opus-5-5[1m]"`, `nivel: "xhigh"`, `conectado_a` (slugs, `portal:<nome>`, `nota:<nome>`, `terminal:<nome>` para terminais Shell de apoio), `skills` (dele + `protocolo-delegacao`, `registro-eventos`), `status: "ativo"`, `desde: "AAAA-MM-DD"`. Acrescente o slug novo em `conectado_a` do `cerebro` (e do `coordenador-trello`, se ligou). Valide (rodando na raiz do repositório):
   ```
   node -e "JSON.parse(require('fs').readFileSync('registro/agentes.json','utf8'));console.log('json ok')"
   ```
3. `registro/agentes.md`: linha na tabela + seção (acionar para, conexões, skills, autonomia, ficha).
4. `registro/projetos.md`: "Agente responsável" e "Diretório" do projeto (se for de projeto). Terminal antigo que entrou na arquitetura sai da lista "fora da arquitetura".
5. `registro/roteamento.md`: linha nova para o domínio; se for projeto, troque "Ainda sem sub-cérebro" daquele prefixo pelo agente.
6. `registro/decisoes.md`: `D-NNN · DD/MM/AAAA · Criação do sub-cérebro <Nome>` com decisão, motivo e "Quem decidiu: dono (P-NNNN)".
7. Ficha: preencha "Configuração do terminal" com os valores reais.

### 10. Teste de identidade
[PEDIDO] (skill `protocolo-delegacao`, timeout 120 s):
```
[PEDIDO] F-AAAAMMDD-NNNN
De: Cérebro Principal → Para: <Nome>
Origem: Cérebro (onboarding)
Tipo: consulta
Pedido: Quem é você, qual seu domínio, quais skills você tem e qual o seu nível de autonomia agora?
Contexto: teste de identidade do onboarding; registre pedido-recebido e o resultado como de costume.
Entregar: [RESPOSTA] curto
Pronto quando: respostas batem com a ficha
Autonomia: só responder; nenhuma alteração
Urgência: normal
```
Confira, na fonte:
1. As respostas batem com a ficha (domínio, skills, autonomia).
2. `node bin/registrar.js fluxo F-AAAAMMDD-NNNN` mostra o `pedido-recebido` dele com o **slug novo** (não `desconhecido`).
3. Existe log bruto do dia em `logs/bruto/<slug>/`. Pasta `desconhecido-<id>` = `terminal_id` errado no `agentes.json`.
4. Modelo, esforço, `CLAUDE.md` da raiz e skills, pela transcrição (a resposta do agente sobre si mesmo não prova nada):
   ```
   node skills/cerebro/onboarding-agente/conferir-transcricao.js --cwd "<cwd do role>" --skills "<skill1>,<skill2>,protocolo-delegacao,registro-eventos"
   ```
   Esperado: `claude-opus-5-5`, esforço `xhigh`, `<raiz do workspace>/CLAUDE.md` carregado, skills presentes. O `[1m]` não aparece na transcrição: confira o `comando` no `listar-terminais.js`.
Algo não bate: corrija (responsabilidade → `maestri role edit`, que **reinicia** o terminal; registro → Edit) e repita o teste.

### 11. Primeiro pedido real, acompanhado
Um pedido pequeno e verificável do domínio dele, escolhido com o dono. Acompanhe com `maestri check`, valide o `Pronto quando` na fonte, confira os eventos e o painel (o agente aparece sozinho, porque o painel lê o `agentes.json`).

### 12. Atualizar o Coordenador do Trello (se o agente recebe demandas)
[AVISO] ao Coordenador do Trello: a partir de agora, demandas do projeto <prefixo> podem ser distribuídas a "<Nome>", que executa; o Coordenador acompanha e valida antes de mover para Concluído.

### 13. Fechar
- `node bin/pendencia.js resolver P-NNNN --nota "<Nome> criado, teste de identidade e primeiro pedido ok em DD/MM HH:MM"`.
- Evento final `execucao` (`direcao`: por que esse desenho; o que ficou A CONFIRMAR).
- Responder ao dono: o que foi criado, onde está, o que ficou pendente.

## Como validar (resumo)
Skills expostas e conferidas · `maestri list` mostra o agente e as conexões · `listar-terminais.js` mostra o slug (não "NÃO REGISTRADO") · `conferir-transcricao.js` sai com 0 · `registrar.js fluxo` mostra os eventos dele com o slug · log bruto do dia em `logs/bruto/<slug>/` · o painel mostra o agente.

## Como registrar
| Momento | `--tipo` | Observação |
|---|---|---|
| Decidiu propor o agente | `decisao` | `direcao`: os sinais concretos |
| Pendência de aprovação | (o `pendencia.js` grava) | |
| Role criado, recrutado, conectado, registro atualizado | `execucao` | um evento por etapa, com `--alteracao` de cada arquivo ou nó |
| Teste de identidade e primeiro pedido | `delegacao` + `resposta-recebida` | `--validacao` com o que foi conferido |
| Algo falhou (recruit, confiança, conexão) | `erro` ou `bloqueio` | o texto exato do erro |

## Armadilhas
- **Recrutar antes do ok** do dono: nível 2.
- **`recruit` sem `--preset`** a partir do Cérebro (terminal Shell) falha. **`--role` de role que não existe** falha: crie e confira antes.
- **Barra invertida** no texto do role ou no `ask`: a CLI transforma `\n` e `\t`.
- **Guardar algo em `<raiz do workspace>/.maestri/`**: o Maestri apaga e regrava. Ficha, responsabilidade, conhecimento e skills ficam no `MAESTRO_DIR`.
- **Editar o prompt do role** (`role edit`/`role write`) reinicia o terminal e o chat se perde: antes, `estado/handoff.md` atualizado e, se o agente estiver em uso, ok do dono.
- **`dismiss`** é destrutivo e deixa órfão o portal ou nota ligado só a ele: nunca sem ok do dono; para trocar o agente use `recruit --replace`.
- **Confiar no relato do agente** sobre modelo e skills: confira na transcrição.
- **Esquecer `terminal_id`**: os logs caem em `desconhecido-<id>` e o painel não mostra o agente.
- **Skill com nome repetido** em dois grupos: as duas disputam o mesmo nome em `.claude/skills/`; renomeie uma antes de expor.
- **Agente fora da raiz** sem `CLAUDE.md` da raiz e sem skills: ver passo 6.

## Checklist final
- [ ] Ficha das 12 perguntas e rascunho da responsabilidade escritos, sem barra invertida, com comandos canônicos.
- [ ] Pendência de aprovação respondida com ok.
- [ ] Conhecimento e skills no `MAESTRO_DIR`; descrição de cada skill começa pelo dono; skills expostas e conferidas.
- [ ] Role criado e conferido com `role show`.
- [ ] Recrutado com `--preset "Claude Code"` e o `--command` com modelo e esforço padrão; diálogo de confiança resolvido.
- [ ] Conexões feitas e conferidas em `maestri list`.
- [ ] `agentes.json` (JSON válido, terminal_id, diretorios), `agentes.md`, `projetos.md`, `roteamento.md`, `decisoes.md` e ficha atualizados.
- [ ] Teste de identidade: respostas, eventos com o slug, log bruto, transcrição (modelo, esforço, CLAUDE.md da raiz, skills).
- [ ] Primeiro pedido real validado na fonte.
- [ ] Coordenador do Trello avisado (se aplicável).
- [ ] Pendência resolvida; evento final; dono informado.
