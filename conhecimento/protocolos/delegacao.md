# Protocolo de delegação

Vale para todos os agentes.

Todo pedido que gera trabalho abre um **fluxo** com id `F-AAAAMMDD-NNNN` (gerado por `registrar novo-fluxo`). O id viaja em toda mensagem entre agentes e em todo evento do log; é ele que liga a sequência inteira no painel.

**Envelope de pedido** (quem delega envia, pela skill de conexão do Maestri):

```
[PEDIDO] F-AAAAMMDD-NNNN
De: Cérebro Principal → Para: Coordenador do Trello
Origem: dono (conversa com o Cérebro)
Tipo: consulta | execução | auditoria | lapidação | estrutura
Pedido: <o que fazer, em uma ou duas frases>
Contexto: <o que o outro agente precisa saber e não tem>
Entregar: <formato da resposta; ex.: RST completo | confirmação com links dos cards>
Pronto quando: <critério verificável>
Autonomia: <o que pode fazer sem voltar a perguntar, dentro das regras do domínio>
Urgência: normal | alta
```

**Envelope de resposta:**

```
[RESPOSTA] F-AAAAMMDD-NNNN
De: Coordenador do Trello → Para: Cérebro Principal
Status: concluído | parcial | bloqueado | precisa-do-dono
Resultado: <o que foi entregue>
O que mudou: <cards, arquivos ou nada>
Validação: <como foi confirmado; ex.: reli o JSON às 15:42>
Pendências: <ids P-NNNN abertas, se houver>
Próximo passo: <se houver>
```

Regras: quem recebe registra `pedido-recebido` no início e o resultado no fim; quem delega registra `delegacao` ao enviar e `resposta-recebida` ao receber. Sem resposta num tempo razoável, quem delegou cobra uma vez e, se continuar travado, abre pendência.

## O dono falando direto com um sub-cérebro

O dono pode conversar direto no terminal de qualquer sub-cérebro. Nesse caso o sub-cérebro abre o próprio fluxo, registra os eventos com `origem: "dono-direto"` e, se a conversa mudar algo que o Cérebro precisa saber (estrutura, decisão, prioridade), manda ao Cérebro um aviso curto `[AVISO] F-… <o que mudou>`. Como o Cérebro lê os eventos recentes ao iniciar cada interação, ele nunca fica desatualizado.

Envelope de aviso:

```
[AVISO] F-AAAAMMDD-NNNN
De: Coordenador do Trello → Para: Cérebro Principal
Origem: dono (conversa direta)
O que mudou: <estrutura, decisão ou prioridade, em uma ou duas frases>
```

## Mecânica no Maestri

- Só dá para falar com quem está **conectado** a você. Rode `maestri list` antes de mandar qualquer coisa e use o nome exatamente como aparece.
- Mandar: `maestri ask "Nome" "<envelope>"`. Envelope longo, com aspas ou várias linhas: escreva num arquivo temporário e mande com `maestri ask "Nome" "$(cat <arquivo>)"` no Git Bash.
- O `ask` só volta quando o outro agente termina. Ajuste o tempo limite da ferramenta ao tamanho do pedido (1 a 10 minutos). Se o tempo estourar, **não reenvie**: rode `maestri check "Nome"` para ver o andamento e espere de novo.
- Resposta maior que uma tela (RST, auditoria): peça no [PEDIDO] que o resultado seja salvo num arquivo dentro de `estado/` (no `MAESTRO_DIR`) e que o [RESPOSTA] traga o caminho; ou peça que o agente responda com `maestri ask "<seu nome>" "<resultado>"`.
- Nunca interrompa um agente que ainda está trabalhando e nunca edite arquivos que ele está mexendo.
- Ao receber um [PEDIDO], registre `pedido-recebido` antes de começar. Ao terminar, registre o resultado e responda com [RESPOSTA] (status: concluído, parcial, bloqueado ou precisa-do-dono).
- Cobrança: sem resposta num tempo razoável, cobre **uma vez** (`[COBRANÇA] F-… ainda aguardando <o quê>`). Se continuar travado, abra pendência e avise o Cérebro.

## Como chamar os comandos

Os comandos ficam em `bin/` deste repositório (o `MAESTRO_DIR`) e são escritos em Node.js, só com a biblioteca padrão.

Sempre a forma canônica, em qualquer shell, com o caminho absoluto: `node <raiz do workspace>/_maestro/bin/registrar.js ...` e `node <raiz do workspace>/_maestro/bin/pendencia.js ...`. Se o seu workspace criar atalhos (um script sem extensão para o Git Bash, um `.cmd` para o PowerShell), use-os só por conveniência: no PowerShell, o arquivo sem extensão não executa nada e não dá erro, e o `.cmd` estraga `^`, `%` e aspas internas.

Texto com aspas, emoji ou várias linhas: prefira mandar o evento inteiro em JSON pela entrada padrão (`--json -`) ou por arquivo (`--json-arquivo`), escrito antes num arquivo temporário, em vez de brigar com aspas na linha de comando.
