# O log de eventos é a única fonte do estado

O estado de cada item, task e pendência não é gravado em lugar nenhum: é calculado pelo painel a partir de um log de eventos append-only (`item-iniciado`, `task-despachada`, `task-status`, `relatorio`, `task-integrada`, `etapa`, `pendencia-aberta`…). Descartamos manter um arquivo de estado por item (como o `estado.json` do antigo `fluxo.py`) ao lado do log, porque o maestro e até três trabalhadores gravam ao mesmo tempo e dois registros do mesmo fato acabariam divergindo; a linha do tempo do item sai do próprio log.
