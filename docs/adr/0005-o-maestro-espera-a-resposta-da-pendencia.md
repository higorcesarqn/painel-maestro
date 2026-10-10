# O maestro espera a resposta da pendência; o painel não o avisa

O dono volta a poder responder uma pendência pelo painel, que grava a decisão em nome dele (papel `owner`). Quem leva a decisão ao maestro é o próprio maestro: ao abrir a pendência, ele deixa `flow pending wait` rodando em segundo plano, e o comando termina quando ela fecha, seja pelo painel, pelo terminal ou por integração. Descartamos o aviso empurrado pelo painel com `maestri ask`, como era o do antigo Cérebro, removido na #10. Esse aviso só funcionava com o servidor do painel rodando num terminal do Maestri ligado ao do maestro, dependia de em que workspace cada um estava e não alcançava o modo subagentes, em que o maestro é uma sessão comum do Claude Code.

## Consequences

- As skills de orquestração (com e sem Maestri) passam a deixar o `wait` rodando a cada `pending open`.
- Uma pendência sem ninguém esperando por ela, como a de HML derivada ou a de uma sessão encerrada, pode ser respondida pelo painel. A decisão fica gravada, mas ninguém é acordado: o maestro a encontra quando retomar o item.
