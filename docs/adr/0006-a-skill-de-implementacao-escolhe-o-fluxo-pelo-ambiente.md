# A skill de implementação escolhe o fluxo pelo ambiente; o modo passado vale mais

Há uma skill de implementação por tracker (`implement-issue` para o GitHub, `implement-pbi` para o Azure DevOps), e não uma por tracker e por ambiente. Ela descobre o ambiente com `flow host` e segue o fluxo dele: `orca` → `docs/orchestration-orca`, `maestri` → `docs/orchestration-maestri`, `none` → `docs/orchestration-subagents`. O dono pode forçar o modo com um argumento depois do número (`/implement-issue 60 subagents`), e o modo passado vale mais que a detecção. O adaptador do tracker fica um só por skill, igual nos três fluxos. Descartamos manter as variantes `implement-issue-maestri` e `implement-pbi-maestri` (e criar as `-orca`), porque diferiam só no ambiente: com o Orca seriam seis skills, com adaptadores copiados que já tinham começado a divergir, e o dono teria que lembrar qual chamar em cada terminal.

## Consequences

- Cada fluxo confere os pré-requisitos dele antes do passo 1. Se um falha (ex.: o modo `maestri` forçado fora do Maestri, ou o workspace do Maestri fora da raiz do repositório), a skill para, diz qual falhou e oferece os subagentes. Ela nunca troca de modo sozinha: o dono sempre sabe em que modo o item rodou.
- Cada `flow task dispatch` passa `--mode` com o modo escolhido, e a página do item mostra o modo de cada task (#62). Sem o `--mode`, o `flow` gravaria o modo do ambiente, que difere do escolhido quando o dono força os subagentes dentro do Orca ou do Maestri.
- No modo subagentes dentro do Orca ou do Maestri, o maestro roda o `flow status` com `MAESTRI_TERMINAL_ID=` e `ORCA_TERMINAL_HANDLE=` vazias, para que o status de uma task não mova o card do worktree do próprio maestro nem poste no floor dele. O `flow pending open` continua avisando o dono no ambiente.
- O trabalhador de um terminal visível é uma skill só, `maestro-worker`, com as regras comuns e uma seção por ambiente (Maestri e Orca). No modo subagentes, o contrato do trabalhador continua no prompt.
- As pastas `implement-issue-maestri` e `implement-pbi-maestri` saem do repositório e vão para a lista `retired` do `skills/links.json`: o `install-skills` remove os links delas.
- Enquanto o fluxo do Orca não existe (#65), o modo `orca` para e oferece os subagentes.
