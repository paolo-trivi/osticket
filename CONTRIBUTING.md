# Contribuire a TailTicket

Grazie per l'interesse. Prima di iniziare leggi la [filosofia](docs/philosophy.md) e lo [scope](docs/scope.md): spiegano cosa accettiamo e perché.

## Regole d'oro
1. **Nessun DDL sul database osTicket.** Niente tabelle, colonne o migrazioni.
2. **Ogni scrittura riproduce il PHP.** Una PR che aggiunge o cambia una scrittura deve includere almeno uno scenario differenziale verde (`apps/web/test/diff/`) e aggiornare il contratto (`apps/web/docs/contract/<area>.md`, poi `npm run docs:contracts`).
3. **Non modificare `legacy/`.** Il codice osTicket si aggiorna solo da upstream ([docs/upstream-sync.md](docs/upstream-sync.md)). Le correzioni a osTicket vanno proposte al progetto originale.
4. **Sicurezza prima della fedeltà.** I bug di sicurezza e permessi di osTicket non si replicano: si applica la regola più stretta e la si documenta.

## Ambiente e verifiche
Segui [docs/development.md](docs/development.md). Prima di aprire una PR:

```bash
cd apps/web
npm run lint && npm run typecheck && npm test && npm run test:diff && npx next build
```

La CI (`.github/workflows/ci.yml`) esegue gli stessi controlli e i test differenziali contro il PHP.

## Stile
- TypeScript strict.
- Testi dell'interfaccia solo in `apps/web/src/messages/` (italiano e inglese).
- Colori solo con i token `brand-*`.
- Proprietà CSS logiche (RTL).
- Componenti TailAdmin esistenti prima di introdurne di nuovi.

Dettagli in [apps/web/AGENTS.md](apps/web/AGENTS.md).

## Commit e PR
- Messaggi di commit chiari, in italiano o inglese, che spieghino il **perché**.
- Una PR per argomento. Descrivi cosa cambia, come l'hai verificato e le eventuali differenze volute rispetto al PHP.
- Contribuendo accetti che il tuo codice sia distribuito con licenza GPL v2.
