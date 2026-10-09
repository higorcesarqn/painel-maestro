# Protocolo de pendências do dono

Vale para todos os agentes. O dono da fila é o Cérebro Principal.

Tudo que precisa de resposta, aprovação ou avaliação do dono do workspace vira uma **pendência** (`pendencia abrir`) com severidade (`critica`, `alta`, `normal`, `baixa`), contexto curto, opções e uma recomendação. O Cérebro é dono da fila: apresenta ao dono, registra a resposta, devolve a decisão ao agente que pediu e fecha. Pendência crítica gera notificação do sistema.

## Comandos (`pendencia`)

| Comando | Faz |
|---|---|
| `pendencia abrir --agente S --fluxo F --severidade alta --tipo decisao --titulo "..." --contexto "..." [--opcao "A: ..." --opcao "B: ..."] [--recomendacao "..."] [--trello shortLink]` | Cria `P-NNNN`, grava, registra evento `pendencia-aberta`, imprime o id |
| `pendencia listar [--abertas] [--severidade S]` | Lista em texto |
| `pendencia responder P-NNNN --resposta "..."` | Guarda a resposta do dono (status `respondida`) |
| `pendencia resolver P-NNNN [--nota "..."]` | Fecha (status `resolvida`), registra `pendencia-resolvida` |
| `pendencia cancelar P-NNNN --motivo "..."` | Fecha sem execução |

Exemplo de `estado/pendencias.json` (dados fictícios):

```json
{
  "pendencias": [
    {
      "id": "P-0003",
      "aberta_em": "2025-01-15T15:45:00-03:00",
      "agente": "coordenador-trello",
      "fluxo_id": "F-20250115-0007",
      "severidade": "alta",
      "tipo": "decisao",
      "titulo": "Cometa: definir etiqueta e prefixo",
      "contexto": "A coluna nova é roxa e o único cartão usa a etiqueta Boreal e o prefixo B:. O prefixo C: ainda está livre.",
      "opcoes": ["A: etiqueta 'Cometa' roxa, prefixo C:", "B: etiqueta 'Cometa' roxa, prefixo CO:", "C: a coluna vira 'Boreal', mantém B:"],
      "recomendacao": "…",
      "trello": {"shortLink": "xxxx", "url": "https://trello.com/c/xxxx"},
      "status": "aberta",
      "resposta": null,
      "resolvida_em": null
    }
  ]
}
```

`tipo`: `aprovacao`, `decisao`, `informacao-faltando`, `revisao`. `severidade`: `critica` (trava algo importante ou tem risco), `alta` (trava uma frente), `normal`, `baixa`.

## Como escrever uma boa pendência
- **Título:** a decisão em uma linha ("Cometa: definir etiqueta e prefixo").
- **Contexto:** só o necessário para o dono decidir sem perguntar nada (o que existe hoje, o que está em jogo).
- **Opções:** 2 a 4, mutuamente exclusivas, cada uma com a consequência principal.
- **Recomendação:** qual opção e por quê, em uma frase.
- **Severidade:** `critica` só quando trava algo importante ou tem risco; o padrão é `normal`.

## Ciclo
1. O agente que precisa abre (`pendencia abrir`) e avisa o Cérebro com [AVISO].
2. O Cérebro apresenta ao dono (pendências críticas e altas sempre aparecem em uma linha nas respostas dele). Pendência crítica gera `maestri notify`.
3. Resposta do dono (na conversa ou pela tela Pendências do painel) → `pendencia responder` → o Cérebro devolve a decisão ao agente de origem com [PEDIDO] no mesmo fluxo.
4. Executado → `pendencia resolver`. Desistiu → `pendencia cancelar --motivo`.

## Como chamar os comandos

Os comandos ficam em `bin/` deste repositório (o `MAESTRO_DIR`) e são escritos em Node.js, só com a biblioteca padrão.

Sempre a forma canônica, em qualquer shell, com o caminho absoluto: `node <raiz do workspace>/_maestro/bin/registrar.js ...` e `node <raiz do workspace>/_maestro/bin/pendencia.js ...`. Se o seu workspace criar atalhos (um script sem extensão para o Git Bash, um `.cmd` para o PowerShell), use-os só por conveniência: no PowerShell, o arquivo sem extensão não executa nada e não dá erro, e o `.cmd` estraga `^`, `%` e aspas internas.

Texto com aspas, emoji ou várias linhas: prefira mandar a pendência inteira em JSON pela entrada padrão (`--json -`) ou por arquivo (`--json-arquivo`), escrita antes num arquivo temporário, em vez de brigar com aspas na linha de comando.
