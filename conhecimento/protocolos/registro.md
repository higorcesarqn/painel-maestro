# Protocolo de registro

Vale para todos os agentes.

- O **log bruto** é automático (hooks): todo prompt recebido, toda ferramenta usada, todo fim de turno, de todo agente.
- O **log semântico** é responsabilidade de cada agente: registrar com `registrar` sempre que receber um pedido, delegar, decidir uma direção, alterar algo, concluir, falhar, bloquear ou abrir pendência. O campo `direcao` explica **qual caminho foi tomado e por quê** (e o que foi descartado, se for relevante). É o que o dono lê no modal do painel.
- Nunca registrar senhas, tokens, chaves ou conteúdo de credenciais.

## As duas camadas
- **Log bruto** (`logs/bruto/<agente>/AAAA-MM-DD.jsonl`): automático, gravado pelos hooks do Claude Code em todo prompt recebido, toda ferramenta usada e todo fim de turno. Ninguém precisa lembrar de nada. O agente é identificado pela variável `MAESTRI_TERMINAL_ID` do terminal (e, na falta dela, pelo diretório de trabalho), conforme `registro/agentes.json`.
- **Log semântico** (`logs/eventos/AAAA-MM.jsonl`): responsabilidade de cada agente, pelo `registrar`. É o que o dono lê na tabela e no modal do painel.

## Quando registrar (log semântico)
Ao receber um pedido · ao delegar · ao receber resposta · ao decidir uma direção · ao alterar algo · ao concluir · ao falhar · ao ficar bloqueado · ao abrir ou resolver pendência.

## Comandos (`registrar`)

Subcomandos:

| Comando | Faz |
|---|---|
| `registrar novo-fluxo [--titulo "..."]` | Gera e imprime `F-AAAAMMDD-NNNN` (contador diário em `estado/contador-fluxos.json`, com trava) |
| `registrar evento --agente S --fluxo F --tipo T --resumo "..." [--direcao "..."] [opções]` | Grava um evento |
| `registrar evento --json '<objeto>'` ou via stdin | Grava um evento completo (para quando houver passos, comandos e alterações) |
| `registrar ultimos [--horas N] [--agente S] [--fluxo F]` | Lista eventos recentes em texto legível |
| `registrar fluxo F` | Mostra a sequência inteira de um fluxo (eventos + resumo dos comandos brutos) |

Valida os campos obrigatórios e os valores permitidos, preenche `id` e `ts`, e grava em `logs/eventos/AAAA-MM.jsonl`.

Schema do evento (dados fictícios):

```json
{
  "id": "EV-20250115-154210-7f3a",
  "ts": "2025-01-15T15:42:10-03:00",
  "agente": "coordenador-trello",
  "fluxo_id": "F-20250115-0007",
  "origem": "cerebro",
  "tipo": "execucao",
  "projeto": "A",
  "trello": {
    "shortLink": "xxxx",
    "titulo": "A: Revisar o fluxo de cadastro",
    "url": "https://trello.com/c/xxxx",
    "status_antes": "Em andamento",
    "status_depois": "Em andamento"
  },
  "resumo": "Leitura completa do quadro e RST gerado",
  "direcao": "Usei o JSON do quadro em vez da interface porque traz espelhos e checklists numa leitura só; nenhuma escrita, o quadro ainda está em somente leitura.",
  "passos": ["Naveguei para o JSON do quadro", "Salvei o bruto", "Normalizei", "Gerei o RST", "Voltei o portal ao quadro"],
  "comandos": ["maestri portal navigate \"trello.com\" \"…json…\"", "maestri portal text \"trello.com\" body"],
  "alteracoes": [],
  "resultado": "ok",
  "validacao": "9 cartões abertos no JSON = 9 no resumo",
  "proximo_passo": "Aguardar ok do dono para as correções mecânicas (P-0004)",
  "precisa_dono": false,
  "pendencias": ["P-0004"],
  "duracao_s": 48
}
```

Valores permitidos:
- `origem`: `dono-direto`, `cerebro`, `rotina`, `agente:<slug>`, `sistema`.
- `tipo`: `pedido-recebido`, `delegacao`, `resposta-recebida`, `aviso`, `consulta`, `execucao`, `auditoria`, `relatorio`, `decisao`, `pendencia-aberta`, `pendencia-resolvida`, `bloqueio`, `erro`, `manutencao`, `bootstrap`.
- `resultado`: `ok`, `parcial`, `falhou`, `bloqueado`, `aguardando-dono`, `em-andamento`.
- Obrigatórios: `agente`, `fluxo_id`, `origem`, `tipo`, `resumo`, `resultado`. `direcao` é obrigatória para `decisao`, `execucao`, `delegacao` e `auditoria`.
- `resumo` até 100 caracteres, começando por verbo ou substantivo concreto. Ruim: "Fiz coisas no Trello". Bom: "Criado espelho de B: Nova landing em 📝 A fazer".
- `direcao` diz o caminho escolhido e o porquê, em 1 a 3 frases.

## Exemplos de `resumo`
- Ruim: "Fiz coisas no Trello" · Bom: "Criado espelho de B: Nova landing em 📝 A fazer"
- Ruim: "Relatório" · Bom: "RST gerado: 9 abertas, 11 alertas mecânicos"
- Ruim: "Erro" · Bom: "Falhou leitura do quadro: portal fora do ar"

## Exemplos de `direcao`
- Bom: "Usei o JSON do quadro em vez da interface porque traz espelhos e checklists numa leitura só; nenhuma escrita, o quadro ainda está em somente leitura."
- Bom: "Movi o espelho em vez de arquivar e recriar, como manda o manual do quadro; o histórico do cartão fica preservado."
- Ruim: "Fiz o que foi pedido." (não diz caminho nem porquê)

## Correlação por fluxo
Se a mensagem que você recebeu tem um id `F-AAAAMMDD-NNNN`, o hook grava esse fluxo como o fluxo atual da sua sessão e os comandos seguintes herdam o id. Use sempre o mesmo id nos seus eventos.

## Segredos
Nunca registre senhas, tokens, chaves ou conteúdo de credenciais. O hook redige padrões conhecidos, mas a responsabilidade é sua.

## Como chamar os comandos

Os comandos ficam em `bin/` deste repositório (o `MAESTRO_DIR`) e são escritos em Node.js, só com a biblioteca padrão.

Sempre a forma canônica, em qualquer shell, com o caminho absoluto: `node <raiz do workspace>/_maestro/bin/registrar.js ...` e `node <raiz do workspace>/_maestro/bin/pendencia.js ...`. Se o seu workspace criar atalhos (um script sem extensão para o Git Bash, um `.cmd` para o PowerShell), use-os só por conveniência: no PowerShell, o arquivo sem extensão não executa nada e não dá erro, e o `.cmd` estraga `^`, `%` e aspas internas.

Texto com aspas, emoji ou várias linhas: prefira mandar o evento inteiro em JSON pela entrada padrão (`--json -`) ou por arquivo (`--json-arquivo`), escrito antes num arquivo temporário, em vez de brigar com aspas na linha de comando.
