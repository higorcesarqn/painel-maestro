# Versão

O painel-maestro tem uma versão só: o semver do `package.json` da raiz. O pacote da UI (`panel/ui/package.json`, privado e só de build) não tem `version`, e a versão do schema do banco (`PRAGMA user_version` do `maestro.db`, #28) é outra coisa, que não acompanha esta.

## Quando subir

- **Item:** o ajuste final de cada item sobe o **minor** (`1.1.0` → `1.2.0`), no commit do ajuste final, junto das correções. O maestro põe a subida no briefing do ajuste final.
- **Correção avulsa** (fora de um item): sobe o **patch** (`1.2.0` → `1.2.1`), no mesmo PR da correção.
- **Tag:** `vX.Y.Z` no commit do merge é opcional e do dono; nada no fluxo depende dela.

## Onde a versão aparece

- No rodapé do menu lateral do painel, junto de "Painel local": `v<semver> · <commit>`, ou só `v<semver>` quando o painel roda de uma pasta sem git (ou sem git no `PATH`).
- No `GET /api/state`: `version: { product, commit }`, lidos quando o servidor sobe (o commit é nulo sem git).
- No CLI: `node bin/flow.js --version` (ou `-v`) imprime `painel-maestro <semver> (<commit>)`, sem o commit fora de git.

O commit é o do código (`git rev-parse --short HEAD` na pasta do repositório), e o do servidor é o da hora em que ele subiu: depois de um `git pull`, o rodapé só muda quando o servidor reinicia.
