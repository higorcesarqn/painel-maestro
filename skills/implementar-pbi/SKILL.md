---
name: implementar-pbi
description: "Implementa um PBI do Azure DevOps inteiro num PR, com um subagente em worktree por task, e grava o fluxo no painel-maestro."
disable-model-invocation: true
---

O usuário passou o ID de um PBI do Azure DevOps. Siga o fluxo em `~/.claude/docs/orquestracao-subagentes/README.md`, usando este arquivo como **adaptador do tracker**. Tipo na branch: `pbi` (ex.: `feature/pbi-10`). Um PBI sem tasks filhas é a própria task.

## Adaptador Azure DevOps

Use a CLI `az` com a extensão `azure-devops`. Organização e projeto vêm de `docs/agents/` do repo ou de `az devops configure --list`; se nenhum estiver definido, pergunte ao usuário e configure com `az devops configure --defaults organization=... project=...`.

- **Item pai e tasks**: `az boards work-item show --id <pbi> --expand relations`. Tasks filhas são as relações `System.LinkTypes.Hierarchy-Forward`; carregue cada uma com `az boards work-item show --id <task> --expand relations`.
- **Arestas de bloqueio**: numa task, a relação `System.LinkTypes.Dependency-Reverse` (Predecessor) aponta para quem a bloqueia. Complemente com linhas `Bloqueada por: #<id>` na descrição (`System.Description`).
- **Estado**: task fechada é a que está em estado da categoria Completed (`Done`, `Closed`...). O estado concluído do projeto vem de `docs/agents/` (ou do `--done-state` do projeto no painel, `node "$PAINEL_MAESTRO/bin/flow.js" project list`); sem convenção escrita, leia-o com `az boards work-item show` num item já concluído. Em boards customizados `Done` pode ser outra etapa do negócio: use o estado que a convenção diz.
- **Abrir PR em rascunho**: `az repos pr create --draft true --source-branch <integradora> --target-branch <origem> --title "PBI <id> — <título>" --work-items <pbi> <tasks...> --description "..."`. A URL para o `flow pr <n> draft --url` é `<repository.webUrl>/pullrequest/<pullRequestId>`, campos da resposta.
- **Marcar task concluída**: `az boards work-item update --id <task> --state <estado concluído>`.
- **Criar task para depois** (achado que o usuário mandou deixar para depois): `az boards work-item create --type Task --title "..."` e ligue ao PBI com `az boards work-item relation add --id <task nova> --relation-type parent --target-id <pbi>`; tags e área seguem `docs/agents/`.
- **Finalizar PR**: `az repos pr update --id <pr> --draft false`.

### Acentos no Windows

No Windows o `az` apaga acentos do texto que recebe como argumento e da saída redirecionada (a do Bash tool inclusive). Ids, relações e estados passam ilesos; títulos e descrições, não. Confira todo texto que o `az` leu ou gravou: título que vai para o painel e para o PR, descrição do PR, task criada. Se houver `?` ou `�` no lugar de uma letra acentuada, leia ou corrija esse texto pela REST, com arquivos UTF-8:

```bash
TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv)
API="https://dev.azure.com/<org>/<projeto>/_apis"
curl -s -H "Authorization: Bearer $TOKEN" "$API/wit/workItems/<id>?api-version=7.1" -o item.json
```

- Leia a resposta com `python -X utf8`, abrindo o arquivo em UTF-8 (JSON pelo stdin do Python passa pelo console cp1252 e perde os acentos), ou com o Read tool.
- Work item: `PATCH "$API/wit/workItems/<id>?api-version=7.1"` com `-H "Content-Type: application/json-patch+json; charset=utf-8" --data-binary @patch.json` (`[{"op":"add","path":"/fields/System.Title","value":"..."}]`).
- PR: `PATCH "$API/git/repositories/<repositório>/pullrequests/<pr>?api-version=7.1"` com `-H "Content-Type: application/json; charset=utf-8" --data-binary @pr.json` (`{"title":"...","description":"..."}`; a descrição tem limite de 4.000 caracteres). O repositório é o último trecho de `git remote get-url origin`.
