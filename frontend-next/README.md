# osTicket Next — nuovo frontend Next.js sul database di osTicket

Interfaccia Next.js (App Router, TypeScript strict, Tailwind v4, template TailAdmin) che lavora **sullo stesso database MySQL di osTicket 1.18**, in contemporanea con il pannello PHP classico.

La knowledge base del prodotto originale è in `../docs/reverse-engineering/` (doc 00–17).

## Regole di coesistenza (da rispettare sempre)
1. **Nessuna modifica allo schema** del DB osTicket: niente migrazioni, ALTER o tabelle nuove.
2. Ogni scrittura produce **le stesse righe** che produrrebbe il PHP (tabelle principali, `thread_event`, `*__cdata`, `_search`, `syslog`…). La specifica è in `docs/reverse-engineering/17-contratto-scrittura.md`.
3. Stesso formato dei dati:
   - datetime nel fuso del server MySQL (`NOW()` lato SQL, vedi `src/server/db/time.ts`);
   - stessa sessione MySQL del PHP (`SQL_MODE=''`, utf8, vedi `src/server/db/index.ts`);
   - JSON codificati come `json_encode` di PHP (`src/server/format/php-json.ts`);
   - niente caratteri a 4 byte.
4. Stessa crittografia di osTicket (bcrypt phpass, `SECRET_SALT` per Message-ID e firme dei file), letta da `ost-config.php`.
5. I processi batch (cron, fetch email, API `/api/tickets.*`) restano al PHP.

## Struttura
```
src/
  app/[locale]/(staff)/agent/   pannello agenti (login, dashboard, ticket…)
  components/shell/             guscio TailAdmin: sidebar, header, menu utente, layout di accesso
  server/
    env.ts                      configurazione condivisa (ost-config.php / variabili d'ambiente)
    db/                         Kysely + mysql2, prefisso tabelle, tipi generati, fuso orario
    config/                     tabella config (namespace core, staff.<id>, …)
    auth/                       password phpass, sessioni, login agenti, tentativi falliti
    domain/<modulo>/            servizi di dominio (port delle classi include/class.*.php)
    format/                     utility compatibili con Format:: di osTicket
    system/                     syslog
dev/                            ambiente di sviluppo: MariaDB + osTicket PHP + Mailpit
scripts/db-codegen.mjs          generazione dei tipi dal DB
test/                           vitest (unit + integrazione sul DB di sviluppo)
```

## Sviluppo
```bash
# 1. installa e avvia osTicket PHP di riferimento (stesso codice del repo) su MariaDB locale
npm run dev:osticket          # crea /home/user/ost-dev/www e il DB "osticket"
npm run dev:services          # MariaDB, Mailpit (:8025) e osTicket PHP (:8080)

# 2. configura e avvia la app
cp .env.example .env.local    # OST_CONFIG_PATH, APP_SESSION_SECRET, OST_PHP_URL
npm install
npm run dev                   # http://127.0.0.1:3000/agent  (devadmin / Passw0rd!dev)

# verifiche
npm run lint && npm run typecheck && npm test
npm run db:codegen            # rigenera i tipi (DATABASE_URL=mysql://user:pass@host/db)
```
