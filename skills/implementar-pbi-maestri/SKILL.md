---
name: implementar-pbi-maestri
description: "Implementa um PBI do Azure DevOps inteiro num PR, com um floor do Maestri e um terminal Claude Code por task. Use só dentro do Maestri, como maestro no Ground."
disable-model-invocation: true
---

O usuário passou o ID de um PBI do Azure DevOps. Siga o fluxo em `~/.claude/docs/orquestracao-maestri/README.md`, usando este arquivo como **adaptador do tracker**. Tipo na branch: `pbi` (ex.: `feature/pbi-10`).

Fora do Maestri (sem `$MAESTRI_CLI`, ou sem Maestro Mode no Ground), pare e sugira `/implementar-pbi`, que usa subagentes.

## Adaptador Azure DevOps

**Leia e escreva pela REST com `curl`, não pelo `az boards`**: no Windows o `az` apaga acentos ao redirecionar a saída e ao receber texto como argumento. O `az` serve só para o token. Organização, projeto e os estados vêm de `docs/agents/issue-tracker.md` do repo; se faltar algo, pergunte ao usuário.

```bash
TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv)
API="https://dev.azure.com/<org>/<projeto>/_apis"
```

Grave toda resposta em arquivo e leia com `python -X utf8` abrindo o arquivo em UTF-8. **Não** passe JSON para o Python pelo stdin: o console cp1252 corrompe os acentos.

- **Item pai e tasks**: `curl -s -H "Authorization: Bearer $TOKEN" "$API/wit/workItems/<id>?\$expand=relations&api-version=7.1" -o pbi.json`. Tasks filhas são as relações `System.LinkTypes.Hierarchy-Forward`; carregue cada uma do mesmo jeito. Comentários: `$API/wit/workItems/<id>/comments?api-version=7.1-preview.4`.
- **Arestas de bloqueio**: numa task, a relação `System.LinkTypes.Dependency-Reverse` (Predecessor) aponta para quem a bloqueia. Complemente com linhas `Bloqueada por: #<id>` na descrição.
- **Estado concluído**: o que `docs/agents/issue-tracker.md` disser. **Nunca chute `Done`**: em boards customizados ele pode significar outra etapa do negócio (no CIDAX, Task e PBI concluídos vão para `Committed`; `Done` joga o card em "Liberado para pagamento").
- **Comando de leitura para o briefing do trabalhador**: as duas linhas do token e do `curl` acima, com o id da task e o do PBI.
- **Marcar task concluída**:
  ```bash
  curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json-patch+json" \
    -d '[{"op":"add","path":"/fields/System.State","value":"<estado concluído>"}]' "$API/wit/workItems/<id>?api-version=7.1" -o resp.json
  ```
- **Editar texto** (descrição, uma regra do PBI que mudou na revisão): leia o item, monte o patch num arquivo UTF-8 (`json.dump(..., ensure_ascii=False)`) com `{"op":"test","path":"/rev","value":<rev lido>}` antes do `add`, e envie com `-H "Content-Type: application/json-patch+json; charset=utf-8" --data-binary @patch.json`. Leia de volta e confira os acentos.
- **Criar item** (achado que fica para depois): `POST "$API/wit/workItems/\$Task?api-version=7.1"` com json-patch de título, descrição, Area, Iteration, Tags (inclua a de triagem) e a relação `System.LinkTypes.Hierarchy-Reverse` para o PBI. Siga as convenções de título e tags do `docs/agents/`.
- **Repositório**: o nome é o último trecho de `git remote get-url origin`; o id vem de `GET $API/git/repositories/<nome>?api-version=7.1`.
- **Abrir PR em rascunho**: `POST $API/git/repositories/<repo>/pullrequests?api-version=7.1` com `{"sourceRefName":"refs/heads/<integradora>","targetRefName":"refs/heads/<origem>","title":"PBI <id> — <título>","description":"...","isDraft":true,"workItemRefs":[{"id":"<pbi>"},{"id":"<task>"},...]}`, em arquivo UTF-8. A descrição tem limite de 4.000 caracteres.
- **Finalizar PR**: `PATCH $API/git/repositories/<repo>/pullrequests/<pr>?api-version=7.1` com `{"isDraft":false,"description":"<descrição final>"}`. Confira `isDraft:false` na resposta.
- **Fechar o PBI**: depois de finalizar o PR, marque o PBI com o estado concluído, se a convenção local mandar.
