# O maestro espera a resposta da pendência; o painel não o avisa

O dono volta a poder responder uma pendência pelo painel, que grava a decisão em nome dele (papel `owner`). Quem leva a decisão ao maestro é o próprio maestro: ao abrir a pendência, ele deixa `flow pending wait` rodando em segundo plano, e o comando termina quando ela fecha, seja pelo painel, pelo terminal ou por integração. Descartamos o aviso empurrado pelo painel com `maestri ask`, como era o do antigo Cérebro, removido na #10. Esse aviso só funcionava com o servidor do painel rodando num terminal do Maestri ligado ao do maestro, dependia de em que workspace cada um estava e não alcançava o modo subagentes, em que o maestro é uma sessão comum do Claude Code.

## Consequences

- As skills de orquestração (com e sem Maestri) passam a deixar o `wait` rodando a cada `pending open`.
- O aviso ao **dono** de uma pendência nova sai do CLI (o `flow pending open` chama o `maestri notify` quando roda num terminal do Maestri, #44) e da página (título, favicon e notificação do navegador, #40); o painel continua sem empurrar nada ao maestro.
- No Orca (#62), o mesmo aviso marca o worktree do maestro como não lido (`orca worktree set --worktree current --unread`), e o onde-responder grava o worktree e o terminal do maestro. A pendência não vira um gate do orquestrador do Orca: o painel segue como registro único (ADR 0002), o Orca é só transporte, e o `flow pending wait` continua sendo como o maestro espera a resposta.
- Uma pendência sem ninguém esperando por ela, como a de HML derivada ou a de uma sessão encerrada, pode ser respondida pelo painel. A decisão fica gravada, mas ninguém é acordado: o maestro a encontra quando retomar o item.
