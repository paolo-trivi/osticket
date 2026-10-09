# Sviluppare TailTicket

## Requisiti

- Node.js ≥ 20.9 (consigliato 22), npm.
- MariaDB o MySQL e PHP 8.3 con mysqli, gd, intl, mbstring, xml, zip, apcu. Servono all'osTicket di riferimento e ai test differenziali.

## Ambiente in 4 comandi

```bash
cd apps/web
npm ci
OST_DEV=$HOME/ost-dev bash dev/ci-setup.sh   # osTicket di legacy/ + DB dalla fixture + Mailpit
npm run dev:services                         # MariaDB, Mailpit (SMTP 1025, UI 8025), osTicket PHP (:8080)
cp .env.example .env.local && npm run dev    # http://127.0.0.1:3000 (portale), /agent, /admin
```

Credenziali della fixture, tutte con password `Passw0rd!dev`:
- admin: `devadmin`;
- agenti: `mrossi`, `lbianchi`, `gverdi`, `aesposito`.

`dev/ci-setup.sh` copia il codice di `legacy/` in `$OST_DEV/www` e carica `dev/fixtures/osticket-dev.sql.gz`. Sono gli stessi dati usati dai test e dalla CI.

## Verifiche prima di ogni commit

```bash
npm run lint && npm run typecheck && npm test   # lint, tipi, unit test
npm run test:diff                               # test differenziali PHP vs TypeScript (DB + email)
npx next build
```

Con APCu installato in PHP serve `apc.enable_cli=1`, come in CI.

## Aggiungere o cambiare una scrittura

1. Leggere il codice PHP di riferimento in `legacy/include/class.*.php` e la knowledge base (`docs/reverse-engineering/`).
2. Scrivere il servizio in `apps/web/src/server/domain/<area>/`, replicando righe, ordine ed effetti collaterali.
3. Aggiungere l'operazione PHP equivalente in `apps/web/test/diff/php/ops/<area>.php` e uno scenario in `apps/web/test/diff/<area>*.diff.test.ts`:
   - `runPhp(op)` esegue il PHP originale;
   - `compareWorkingDatabases()` confronta tutte le tabelle;
   - `mailsOf()` confronta le email.
4. Documentare le righe scritte in `apps/web/docs/contract/<area>.md` e rigenerare il doc 17 con `npm run docs:contracts`.
5. Le differenze volute (solo sicurezza e permessi) vanno annotate nel codice e nel contratto.

Per vedere cosa scrive il PHP per un'operazione:

```bash
node test/diff/trace.mjs '{"op":"ticket.reply","args":{"agent":2,"ticket":3,"response":"<p>ciao</p>"}}'
```

## Regole del codice

Sono in [apps/web/AGENTS.md](../apps/web/AGENTS.md). In breve:
- nessun DDL;
- accesso al DB solo da `src/server/**`;
- testi solo in `src/messages/*` (it ed en);
- colori solo con i token `brand-*`;
- proprietà CSS logiche (RTL);
- navigazione da `@/i18n/navigation`.

Il diario operativo del lavoro (stato, verifiche, lavoro in parallelo con più agenti) è in [apps/web/RESTART.md](../apps/web/RESTART.md).
