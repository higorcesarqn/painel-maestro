# As skills gravam o estado do fluxo num lugar fixo; o painel não procura

As skills de implementação (maestro e trabalhador, com ou sem Maestri) passam a gravar o estado de cada item e um log de eventos numa pasta central, pelos scripts de `bin/` deste repositório, e o painel só lê essa pasta. Descartamos fazer o painel varrer os scratchpads de sessão (`AppData\Local\Temp\claude\*\*\scratchpad\estado*.json`) e cruzar com `maestri floor list`, `git worktree list`, `gh` e `az`: os scratchpads são temporários, por sessão, com nomes que já variavam na prática (`estado-3100.json`), e o histórico sumiria com eles.

## Consequences

- O portal por item gerado pelo `fluxo.py` (Mermaid via CDN) deixa de existir: o portal do Maestri abre a página do item no painel.
- O relatório do trabalhador, que antes só existia como texto colado no terminal do maestro, passa a ser gravado.
- Mudar as skills é pré-requisito: sem elas gravarem, o painel fica vazio.
- Única exceção: o merge do PR, que costuma acontecer na interface do tracker sem nenhum agente presente. Para itens com PR pronto e não mergeado, o painel consulta o PR (`gh pr view` ou a REST do Azure DevOps com o token do `az`), só leitura, e grava o evento; um botão "marcar como mergeado" cobre quando a consulta falha.
