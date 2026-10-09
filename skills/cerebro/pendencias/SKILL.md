---
name: pendencias
description: 'Cérebro Principal · Use para tudo da fila de pendências do dono: abrir uma pendência com contexto, opções e recomendação, escolher a severidade, notificar o dono quando for crítica (maestri notify), apresentar a fila, registrar a resposta dele, atualizar a liberação de escrita do Trello quando ele aprovar, devolver a decisão ao agente de origem com [PEDIDO] no mesmo fluxo e fechar (resolver ou cancelar) com pendencia.js.'
---

# Pendências do dono (responsável: Cérebro Principal)

**Resultado:** tudo que precisa de resposta, aprovação ou avaliação do dono está na fila (`estado/pendencias.json`), escrito para ele decidir sem perguntar nada, e cada pendência anda até fechar: aberta → respondida → decisão devolvida a quem pediu → executada e validada → resolvida (ou cancelada).

Regra: `conhecimento/protocolos/pendencias.md`. Ajuda real: `node bin/pendencia.js --help`.

> Caminhos relativos à raiz deste repositório, que no workspace é o `MAESTRO_DIR`. O `registro/decisoes.md` e o `estado/handoff.md` não vêm no repositório: são do workspace de quem usar.

## Quando usar
- Algo de nível 2 (estrutura, regra, nome, mudança em massa, sub-cérebro novo, rotina que gasta tokens) ou nível 3 (negócio, prioridade, escopo, prazo, responsável, exclusão, contexto não escrito) precisa do dono.
- Chegou [AVISO] de um sub-cérebro dizendo que abriu uma pendência.
- O dono respondeu uma pendência (na conversa, ou pela tela Pendências do painel: passo 5b).
- Ao iniciar a sessão e antes de responder ao dono: revisar a fila.

## Quando NÃO usar
- Pergunta rápida que o dono responde na mesma conversa e que não trava nada: pergunte direto (skill `orquestracao`, "uma pergunta só").
- Decisão que é sua (nível 1 do Cérebro: roteamento, formato, manutenção do painel e scripts, organização do `MAESTRO_DIR`): decida, registre `decisao`.
- Para "lembrar" algo seu: use `estado/handoff.md` ou um evento com `--proximo-passo`.

## Pré-requisitos
- Fluxo do assunto (`F-AAAAMMDD-NNNN`); a pendência herda o fluxo da sessão se você não passar `--fluxo`, mas passe sempre.
- Ver se já existe pendência igual: `node bin/pendencia.js listar --todas`. Não abra duplicada.

## Comandos (forma canônica: sempre `node bin/pendencia.js`)
| Faz | Comando |
|---|---|
| Abrir | `node bin/pendencia.js abrir --fluxo F --severidade S --tipo T --titulo "..." --contexto "..." --opcao "A: ..." --opcao "B: ..." --recomendacao "..." [--trello shortLink] [--agente slug]` |
| Listar | `... pendencia.js listar` (abertas e respondidas) · `listar --abertas` · `listar --todas --severidade alta` · `--json` |
| Ver uma | `... pendencia.js mostrar P-0003` |
| Guardar a resposta do dono | `... pendencia.js responder P-0003 --resposta "..."` (status `respondida`; grava evento `decisao` com origem `dono-direto`) |
| Fechar executada | `... pendencia.js resolver P-0003 --nota "o que foi feito e como foi conferido"` (grava `pendencia-resolvida`) |
| Fechar sem executar | `... pendencia.js cancelar P-0003 --motivo "..."` |
O id aceita `P-0003`, `p-3` ou `3`. Saída: 0 ok · 2 validação (lista o problema) · 3 trava esgotada (tente de novo).

## Passo a passo
### 1. Escrever bem (antes de abrir)
| Campo | Regra | Ruim | Bom |
|---|---|---|---|
| `--titulo` | A decisão em uma linha | "Problema no Trello" | "Eco: definir etiqueta e prefixo" |
| `--contexto` | Só o necessário para decidir sem perguntar: o que existe hoje e o que está em jogo; 1 a 3 frases | "Ver auditoria" | "A coluna nova Eco é amarela, o único cartão dela usa a etiqueta Boreal e o prefixo B:. O prefixo E: está livre." |
| `--opcao` | 2 a 4, mutuamente exclusivas, cada uma com a consequência principal, começando por "A:", "B:"... | "A: sim" | "A: etiqueta Eco amarela, prefixo E: (renomeia 1 cartão)" |
| `--recomendacao` | Qual opção e por quê, em uma frase | "Tanto faz" | "A, porque segue o manual do quadro: cada projeto tem etiqueta própria, da cor da coluna, e um prefixo só seu." |
| `--tipo` | `aprovacao` (sim/não sobre algo pronto) · `decisao` (escolher entre opções) · `informacao-faltando` (só o dono sabe) · `revisao` (avaliar algo entregue) | | |
| `--trello` | shortLink ou URL do cartão, quando houver | | |
Lista longa (ex.: "Aprovar correções mecânicas", um item por linha com link): a lista vai **dentro do contexto**, numerada, um item por linha com o link, mandada por JSON (passo 2b). O dono decide lendo só a pendência; caminho de arquivo pode ir como complemento, nunca no lugar da lista.

### 2. Escolher a severidade
| Severidade | Quando | Notifica? |
|---|---|---|
| `critica` | Trava algo importante ou tem risco (dado em perigo, algo quebrado que afeta tudo, prazo do dono) | Sim, notificação do sistema |
| `alta` | Trava uma frente de trabalho | Não; aparece em uma linha em toda resposta ao dono |
| `normal` (padrão) | Precisa do dono, mas nada parado depende disso agora | Não |
| `baixa` | Melhoria, sugestão, pode esperar | Não |
Na dúvida entre duas, a mais baixa, exceto quando há risco: aí `critica`.

### 2a. Abrir pela linha de comando
```
node bin/pendencia.js abrir --fluxo F-AAAAMMDD-NNNN --severidade alta --tipo decisao --titulo "Eco: definir etiqueta e prefixo" --contexto "A coluna nova Eco é amarela e o único cartão usa a etiqueta Boreal; o prefixo E: está livre." --opcao "A: etiqueta Eco amarela, prefixo E:" --opcao "B: manter o cartão em Boreal, sem coluna própria" --recomendacao "A, porque segue o manual do quadro: um projeto, uma etiqueta e um prefixo." --trello xxxx
```
Imprime o id (`P-NNNN`). O evento `pendencia-aberta` já é gravado: não registre outro.

### 2b. Abrir por JSON (aspas, apóstrofo, emoji, listas)
Escreva com a ferramenta Write num arquivo da pasta temporária, por exemplo `<tmp>/maestro-pendencia.json` (`<tmp>` é a pasta temporária do sistema, escrita com barras normais):
```json
{
  "fluxo_id": "F-AAAAMMDD-NNNN",
  "severidade": "alta",
  "tipo": "aprovacao",
  "titulo": "Aprovar correções mecânicas do primeiro ciclo",
  "contexto": "Correções de nível 1 achadas na leitura de 15:41. Nada foi alterado ainda: o quadro está em somente leitura. Com o ok, o Coordenador faz item por item e confere relendo o JSON.\n1. A: Formulário de cadastro → criar espelho em 📝 A fazer · https://trello.com/c/xxxx\n2. B: Testar a importação → mover espelho para ⏳ Em andamento · https://trello.com/c/yyyy\n3. C: Página inicial → corrigir prefixo para C: · https://trello.com/c/zzzz",
  "opcoes": ["A: aprovar os 3 itens e liberar o nível 1 do manual daqui em diante, incluindo arquivar", "B: aprovar só os 3 itens desta lista", "C: aprovar só alguns (o dono diz os números)", "D: não aprovar agora"],
  "recomendacao": "A, porque são todas mecânicas pelo manual do quadro, cada uma é conferida no JSON, e o autonomia.md prevê liberar o nível 1 depois desta aprovação.",
  "trello": null
}
```
```
node bin/pendencia.js abrir --json - < <tmp>/maestro-pendencia.json
```
(Git Bash; no PowerShell, o melhor caminho é `node bin/pendencia.js abrir --json-arquivo <tmp>/maestro-pendencia.json`.)
O `\n` dentro do `contexto` é a quebra de linha do próprio JSON (o `pendencia.js` lê o arquivo, não a CLI do Maestri). Só vale neste arquivo: em `maestri ask`, `note` e `routine` nunca há barra invertida, porque a CLI transforma `\n` e `\t`. Se o seu agente do Trello tiver um script de auditoria, ele pode gerar a pendência de mecânicos já pronta, neste formato.

### 3. Notificar quando for crítica
- Aberta **por você** (terminal Maestro): o `pendencia.js` já tenta `maestri notify` e imprime se saiu. Confira a linha de aviso que diz que a pendência é crítica e se a notificação foi enviada.
- Aberta **por um sub-cérebro** (sem Maestro, a notificação não sai; o script manda ele avisar você): ao receber o [AVISO], notifique:
  ```
  maestri notify "P-0007 crítica: <título curto>. Detalhes no painel e no terminal do Cérebro."
  ```
  Até 500 caracteres, sem barra invertida.
- Pendência de teste (`--teste`) nunca notifica.

### 4. Apresentar ao dono
- Ao iniciar a sessão: `pendencia.js listar --abertas`.
- Em toda resposta ao dono: críticas e altas abertas, uma linha cada (skill `orquestracao`, passo 10).
- Quando for a hora de decidir, mostre a pendência inteira, curta:
  ```
  P-0003 [alta] Eco: definir etiqueta e prefixo
  Hoje: a coluna nova Eco é amarela e o único cartão usa a etiqueta Boreal; o prefixo E: está livre.
  A) etiqueta Eco amarela, prefixo E:   B) manter o cartão em Boreal, sem coluna própria
  Recomendo <opção>: <motivo, como está gravado na pendência>.
  ```
- A recomendação que você apresenta é **a gravada na pendência** (`pendencia.js mostrar`), nas palavras de quem abriu. Não troque. Se discordar, diga ao dono em uma linha separada, com o motivo ("Eu iria de B porque …").
- Várias de uma vez: ordem da fila (severidade, depois idade). Deixe o dono responder várias numa frase ("3: A, 5: não").

### 5. Registrar a resposta do dono
Use as palavras dele, sem reinterpretar. Resposta ambígua: uma pergunta antes de registrar.
```
node bin/pendencia.js responder P-0003 --resposta "Opção A: etiqueta Eco amarela, prefixo E:"
```
O script grava o evento `decisao` (origem `dono-direto`). Decisão que vale para o futuro (regra, estrutura, padrão): registre também no `registro/decisoes.md` do workspace (próximo número, data, decisão, motivo, quem decidiu: o dono).

### 5b. Resposta que chega pelo painel
O dono também responde na tela **Pendências** do painel (opção + comentário). O servidor do painel já roda o `pendencia.js responder` (status `respondida`, evento `decisao`) e, se o aviso ao Cérebro estiver ligado, manda ao seu terminal, por `maestri ask`, uma linha assim:
```
[RESPOSTA DO DONO PELO PAINEL] P-0003 · fluxo F-AAAAMMDD-NNNN · aberta por coordenador-trello · <título> · Resposta: A: ... · Já gravada às 10:42 com pendencia.js responder (status respondida). Siga a skill pendencias: ...
```
1. **Não rode o passo 5 de novo**: a resposta já está gravada. Confira com `pendencia.js mostrar P-0003` (status `respondida`, a mesma resposta). Se não estiver, trate a linha como texto qualquer e pergunte ao dono.
2. Resposta ambígua ou que contradiz a opção escolhida: uma pergunta ao dono antes de seguir (a pendência continua `respondida`; corrigir é só registrar a nova resposta com `pendencia.js responder`).
3. Siga do passo 5a (se for a liberação do Trello) ou do passo 6 em diante, no fluxo da pendência.
4. A linha chega como prompt no seu terminal e entra na fila se você estiver ocupado; responda curto (o `ask` do servidor não espera a sua resposta, ninguém a lê).

### 5a. Liberação de escrita do Trello (pendência "Aprovar correções mecânicas do primeiro ciclo")
As skills do Coordenador só escrevem quando `conhecimento/protocolos/autonomia.md`, seção "Estado atual das liberações", deixa de dizer "somente leitura". **Quem muda essa linha é você** (o Coordenador nunca edita protocolo). Quando o dono responder essa pendência:
1. A pendência já separa o escopo nas opções (A: itens + nível 1 daqui em diante, com arquivar · B: só a lista · C: só alguns · D: não agora). Se a resposta não diz qual, **uma** pergunta antes de registrar: "O ok vale só para os itens desta lista, ou para todo o nível 1 do manual daqui em diante? Inclui arquivar (limpeza semanal e espelhos órfãos)?"
2. `pendencia.js responder` com as palavras dele (passo 5).
3. Com a ferramenta Edit, troque a linha **Trello** da seção "Estado atual das liberações" pelo escopo exato. Exemplos:
   - Só a lista: `- **Trello:** escrita liberada só para os itens 1, 2 e 4 da P-NNNN (ok do dono em DD/MM/AAAA). Todo o resto continua somente leitura.`
   - Nível 1 em geral: `- **Trello:** nível 1 do manual liberado desde DD/MM/AAAA (P-NNNN), incluindo arquivar na limpeza semanal.` (ou "sem arquivamento", se ele disse)
   - "Não aprovar agora": a linha fica como está.
4. Registre a decisão no `registro/decisoes.md` com o escopo, e cite o escopo no campo `Autonomia:` do [PEDIDO] de devolução (passo 6).
5. Registre um evento `execucao` (`--alteracao "autonomia.md: Estado atual das liberações"`, `--direcao` com o escopo e o P-NNNN).

### 6. Devolver a decisão ao agente de origem
O agente está no campo `agente` (`pendencia.js mostrar P-0003`). Mande um [PEDIDO] **no mesmo fluxo da pendência** (skill `protocolo-delegacao`):
```
[PEDIDO] F-AAAAMMDD-NNNN
De: Cérebro Principal → Para: Coordenador do Trello
Origem: dono (resposta à P-0003)
Tipo: estrutura
Pedido: executar a decisão do dono na P-0003: <resposta, nas palavras dele>
Contexto: <o que a decisão muda; o que NÃO foi autorizado>
Entregar: [RESPOSTA] com o que mudou, links e validação
Pronto quando: <critério verificável ligado à decisão>
Autonomia: só o que a P-0003 autorizou; qualquer coisa além disso volta como pendência nova
Urgência: normal
```
Pendência que é sua (ex.: aprovar um sub-cérebro, uma rotina): execute você mesmo pela skill correspondente.
Opção "não fazer" escolhida: vá direto ao passo 7 com `cancelar`.

### 7. Fechar
- Execução confirmada no [RESPOSTA] **e** conferida na fonte:
  ```
  node bin/pendencia.js resolver P-0003 --nota "Etiqueta Eco criada e 1 cartão ajustado; reli o JSON às 16:10"
  ```
- O dono desistiu, a pendência perdeu o sentido ou foi absorvida por outra:
  ```
  node bin/pendencia.js cancelar P-0004 --motivo "Absorvida pela P-0003"
  ```
- Avise o dono do fechamento só se ele estiver esperando o resultado (uma linha).

## Como validar
- `pendencia.js mostrar P-NNNN` mostra o status certo (`aberta` → `respondida` → `resolvida`/`cancelada`) e as datas.
- `registrar.js fluxo F-…` mostra `pendencia-aberta`, `decisao` (resposta), o [PEDIDO] de execução, os eventos do agente e `pendencia-resolvida`, em ordem.
- No painel, a tela Pendências mostra a contagem igual a `listar --abertas` (quando o painel estiver no ar, skill `painel`).

## Como registrar
O `pendencia.js` grava sozinho `pendencia-aberta`, `decisao` (em `responder`) e `pendencia-resolvida` (em `resolver` e `cancelar`). Você registra à parte só a `delegacao` do passo 6 e a `resposta-recebida` do agente (skill `registro-eventos`), citando `--pendencia P-NNNN`.

## Armadilhas
- **Resolver ao receber a resposta.** `responder` ≠ `resolver`: resolve só depois de executado e conferido.
- **Recomendação que decide no lugar do dono** em assunto de nível 3: recomende, mas apresente as opções e espere.
- **Opções que se sobrepõem** ("A: renomear", "B: renomear e mover"): o dono não consegue escolher uma só.
- **Contexto que exige abrir outro lugar para entender.** O dono tem de decidir lendo só a pendência.
- **Crítica sem notificação** quando aberta por sub-cérebro: o script não consegue notificar de lá; você notifica.
- **Executar mais do que foi autorizado** no [PEDIDO] de devolução.
- **Texto com aspas ou acentos pelo atalho `pendencia.cmd`:** estraga. Use sempre `node bin/pendencia.js` ou JSON.
- **Testes:** sempre `--teste` (o painel esconde e não notifica).

## Checklist final
- [ ] Não havia pendência igual (`listar --todas`).
- [ ] Título = a decisão; contexto suficiente; 2 a 4 opções exclusivas com consequência; recomendação em uma frase.
- [ ] Severidade certa; crítica notificada (pelo script ou por `maestri notify`).
- [ ] Mencionada ao dono (críticas e altas em toda resposta).
- [ ] Resposta registrada com `responder`, nas palavras dele; decisão duradoura em `decisoes.md`.
- [ ] Pendência de liberação do Trello respondida → linha "Estado atual das liberações" do autonomia.md atualizada com o escopo exato (passo 5a).
- [ ] Decisão devolvida ao agente de origem com [PEDIDO] no mesmo fluxo, com autonomia limitada ao que foi autorizado.
- [ ] Execução conferida na fonte antes de `resolver`; ou `cancelar` com motivo.
