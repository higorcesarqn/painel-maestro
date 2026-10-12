# Código em inglês, interface em português por dicionário

Todo o código e os contratos internos (identificadores, arquivos, comentários, CLI e subcomandos, tipos de evento, rotas e campos da API, variáveis de ambiente, tabelas do banco) são em inglês; só o que uma pessoa lê (a página e as mensagens do CLI) é em português, vindo de um dicionário pt-BR para que o inglês possa entrar depois. O servidor nunca devolve frases: devolve códigos com parâmetros (`{code: "hook_stale", hours: 26}`) e a página traduz, para que o texto viva num lugar só e os testes confiram códigos, não frases. Documentação, glossário, ADRs, issues e commits continuam em português.

## Adendo (#61): skills em inglês

As skills de `skills/` e os documentos de orquestração de `skills/docs/` (com os nomes das pastas e os comentários dos scripts) passam para o inglês: não são texto que uma pessoa lê, são contrato lido por agente, como o resto do código. O que o agente diz ao dono e o que ele grava no painel (títulos, contexto, opções, decisões, resumos, relatórios) segue em português, e cada skill diz isso. As mensagens do `flow` e dos scripts continuam em português; as skills que decidem por uma delas (ex.: "já foi iniciado", "A decisão veio do painel", `integrar: painel: ...`) a citam ao pé da letra, então mudar uma dessas frases pede mudar a skill junto.
