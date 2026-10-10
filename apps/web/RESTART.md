# RESTART — come riprendere il lavoro su TailTicket (apps/web)

Aggiornato al 09/10/2026. Branch `claude/nextjs-frontend` → PR https://github.com/paolo-trivi/tailticket/pull/1.
I commit hanno autore **paolo-trivi** (`paolo.trivisonno@gmail.com`), **senza righe Co-Authored-By / Claude-Session** (regola fissa).

Obiettivo: **TailTicket**, nuova app **Next.js** (cartella `apps/web/`, base grafica TailAdmin) sullo **stesso DB MySQL di osTicket 1.18.4**. Il pannello PHP deve continuare a funzionare in parallelo, e ogni scrittura di TailTicket deve produrre **le stesse righe** (e le stesse email) del PHP.

**Stato: milestone M0–M7 completate.** Restano solo i limiti noti (§5) e le rifiniture elencate in §4.

Struttura del fork (dalla radice del repo):

| Cartella | Contenuto |
|---|---|
| `apps/web/` | TailTicket (questa cartella) |
| `legacy/` | osTicket 1.18.4 originale, intatto. Aggiornamenti con `git merge -X subtree=legacy upstream/develop` ([docs/upstream-sync.md](../../docs/upstream-sync.md)) |
| `deploy/` | stack Docker in un comando: `./tailticket up` ([deploy/README.md](../../deploy/README.md)) |
| `docs/` | filosofia, scope, compatibilità, architettura, brand, pagina di presentazione `docs/index.html`, knowledge base `reverse-engineering/` |
| `.github/` | workflow `ci` (qualità + test differenziali) e `images` (immagini GHCR) |

Documenti da leggere prima di toccare codice:
1. `docs/philosophy.md`, `docs/scope.md`, `docs/compatibility.md`: principi, perimetro, promessa sul database.
2. `apps/web/README.md`: funzioni, CI, limiti noti.
3. `apps/web/AGENTS.md`: regole del progetto.
4. `apps/web/docs/parallel-brief.md`: convenzioni, API già pronte, come testare (brief per gli agenti).
5. `docs/reverse-engineering/00-INDICE.md`: knowledge base di osTicket (doc 00–17). I percorsi PHP citati sono relativi a `legacy/`.
6. `docs/reverse-engineering/17-contratto-scrittura.md`: contratto di scrittura. La §3 è generata da `apps/web/docs/contract/*.md` (un file per area: core, actions, ticketedit, create, people, portal, admin, adminsys) con `npm run docs:contracts`.

---

## 1. Rimettere in piedi l'ambiente (container nuovo o riavviato)

```bash
# pacchetti di sistema (se mancano): MariaDB e PHP 8.3 con mysqli, gd, intl, mbstring, xml, zip, apcu
apt-get install -y mariadb-server php8.3-apcu
echo "apc.enable_cli=1" > /etc/php/8.3/cli/conf.d/99-apcu-cli.ini   # come in CI (vedi §2)
service mariadb start

cd apps/web
npm ci
OST_DEV=/home/user/ost-dev bash dev/ci-setup.sh   # copia legacy/ in ost-dev, DB "osticket" dalla fixture, ost-config.php, Mailpit
npm run dev:services                               # MariaDB, Mailpit (SMTP 1025 / UI 8025), osTicket PHP su :8080
cp .env.example .env.local                         # OST_CONFIG_PATH=/home/user/ost-dev/www/include/ost-config.php …
npm run dev                                        # http://127.0.0.1:3000 (portale), /agent, /admin
```

Se il container è stato solo riavviato basta `npm run dev:services`.
In alternativa (dati casuali, non quelli dei test): `npm run dev:osticket && php dev/seed.php /home/user/ost-dev/www`.

Credenziali (password `Passw0rd!dev` per tutti):
- admin: `devadmin`;
- agenti: `mrossi` (id 2), `lbianchi` (3), `gverdi` (4), `aesposito` (5).

Avvertenze pratiche:
- **Mai** usare `pkill -f …`, perché uccide la shell stessa. Usare `fuser -k <porta>/tcp`.
- Next 16 permette **un solo `next dev` per cartella**.
- In `next dev` l'HMR via 127.0.0.1 a volte non idrata: per le prove E2E usare `next build && next start`.
- L'utente DB `osticket` ha permessi solo su `osticket` e `osticket_diff%`: le copie del DB per prove manuali devono avere quel prefisso.
- Dopo una `next build`, `tsc` può segnalare errori in `.next/types/validator.ts` se si cancellano pagine: `rm -rf .next`.

---

## 2. Verifiche (da fare prima di ogni commit)

```bash
npm run lint && npm run typecheck && npm test        # lint, tipi, unit
npm run test:diff                                    # 33 file, 351 scenari differenziali PHP vs TypeScript
npx next build
```

I test differenziali confrontano **tutte le tabelle** del DB e le email via Mailpit.
- `OST_DIFF_TAG` separa i DB (`osticket_diff_<tag>_{base,php,ts}`).
- Per lavorare in parallelo ogni area usa anche un Mailpit proprio:
  ```bash
  OST_DIFF_TAG=actions MAILPIT_SMTP_PORT=1026 MAILPIT_HTTP_PORT=8026 \
    npx vitest run -c vitest.diff.config.mts test/diff/ticket-actions.diff.test.ts
  /home/user/ost-dev/bin/mailpit --smtp 127.0.0.1:1026 --listen 127.0.0.1:8026 --smtp-auth-accept-any --smtp-auth-allow-insecure &
  ```
- Cosa scrive il PHP per un'operazione: `node test/diff/trace.mjs '{"op":"ticket.reply","args":{"agent":2,"ticket":3,"response":"<p>ciao</p>"}}'`.
- Operazioni PHP del runner: `test/diff/php/ops/<area>.php` (non toccare `runner.php`).

Tempi e confronti: le date calcolate da `NOW()` (scadenze SLA, `est_duedate`) possono cadere a cavallo di un secondo tra PHP e TS. Alcuni test confrontano quelle colonne con tolleranza di 1–2 s, mai nell'harness condiviso.

CI GitHub Actions (`.github/workflows/ci.yml`):
- job `quality`: lint, typecheck, unit, build;
- job `differential`: MariaDB e PHP 8.3, osTicket dalla fixture con `dev/ci-setup.sh`, poi `npm run test:diff`.
- In CI l'estensione **APCu** è caricata: serve `apc.enable_cli=1` (impostato nel workflow), altrimenti `SavedQueue::clearCounts` del PHP va in errore fatale.
- **Se cambia il DB di sviluppo** su cui si basano i test, rigenerare la fixture:
  `mysqldump -u root --single-transaction --skip-dump-date --no-tablespaces osticket | gzip -9n > dev/fixtures/osticket-dev.sql.gz`

---

## 3. Stato per milestone

| Milestone | Stato | Scenari diff | Note |
|---|---|---|---|
| M0 Fondamenta | fatto | 3 (login) | scaffold, DB Kysely, config, login agenti, harness, branding, tema da admin |
| M1 Agenti sola lettura | fatto | 10 (code, accesso) | code/contatori/visibilità, ricerca, vista ticket, utenti/org, KB, canned, task, profilo, dashboard |
| M2.1/M2.2 Scritture base | fatto | 9 + 2 SLA + 2 date | nota, risposta, stato, lock, eventi, `_search`, mailer, crypto, SLA, composer con allegati |
| M2.3 A Azioni ticket ("actions") | fatto | 47 | assegna/claim/rilascio/trasferimento/referral (anche rimozione)/stato/riapertura/segna risposto |
| M2.3 B Modifica ticket ("ticketedit") | fatto | 60 | update/editField/proprietario, collaboratori, merge/link, delete, scaduto, ban, massa, export CSV, modifica voce |
| M3 A Creazione ticket ("create") | fatto | 43 | `createTicket`/`openTicket`, filtri, numerazione, form dinamici, allegati, `/agent/tickets/new` |
| M3 B Task/utenti/org/profilo ("people") | fatto | 28 | task UI, CRUD utenti/org + import CSV + account, profilo, password, 2FA email, reset |
| M4 Portale clienti ("portal") | fatto | 37 | login/registrazione/reset/ospite/token, ticket, `postMessage`, apertura, KB, profilo |
| M5 A Admin ("admin") | fatto | 34 | impostazioni, reparti, topic, SLA, orari, agenti, team, ruoli, dashboard |
| M5 B Admin di sistema ("adminsys") | fatto | 30 | email/account/template/ban list/diagnostica, filtri, form, liste, pagine, code, API key, log, sistema, plugin |
| M6 Deploy/CI/hardening | fatto | — | CI verde, Dockerfile, basePath, CSP con nonce |
| M7 Fork TailTicket | fatto | — | `legacy/` + `apps/web/`, brand TailTicket, documentazione e presentazione, stack `deploy/` (Caddy, osTicket + cron, MariaDB, backup/update, modalità attach), guardia sulla firma dello schema (`src/server/system/schema-compat.ts`), workflow `images` |

Integrazioni fatte dal coordinatore: eliminazione definitiva agganciata allo stato "deleted" e all'eliminazione utente con ticket (`deleteTicketViaDeletedStatus`), link "Task (n)" nella vista ticket, `createTicket` nel portale, allegati nel composer, date dei template come ICU (`FormattedDate`), destinatari ordinati per nome e serializzati in ordine, `htmlChars` = `Format::htmlchars`, attributi obbligatori di htmLawed nel sanitizer, cifratura SMTP ricavata da host/porta come `class.mail.php`.

---

## 4. Rifiniture possibili (non bloccanti)

- `changeTicketStatus` rilegge i figli dopo aver eliminato il padre: oggi l'eliminazione dei figli avviene dentro `ticketHardDelete({children})`. Si può semplificare leggendo i figli prima di `setTicketStatus`.
- `test/diff/tasks.diff.test.ts` contiene un aggiramento per i bit errati di `TopicFlag`, ora corretti: si può togliere.
- Voci mancanti nella UI agenti:
  - "Gestisci form" del ticket;
  - "Modifica e reinvia";
  - stampa PDF;
  - risposte predefinite nel form di apertura;
  - apertura di un ticket da una voce di thread;
  - export delle ricerche ad hoc.
- Messaggi temporanei ("flash") dopo il ritorno alla lista ticket, come fa il PHP dopo un redirect.
- Modifica inline dei campi nella tabella dei dettagli (oggi è il dialogo "Modifica un campo").
- Admin:
  - creazione e modifica delle code (criteri, colonne);
  - configurazione dei singoli campi dei form;
  - proprietà avanzate degli elementi di lista;
  - import CSV delle liste;
  - traduzioni;
  - editor visuale di template e pagine.

### Ripartire con gli agenti in parallelo (se serve altro lavoro)
- Lanciarli **a ondate di massimo 3**: con di più si supera il limite dell'API (429).
- Ogni agente legge per primi `docs/parallel-brief.md` e `AGENTS.md`, poi lavora solo sulla sua area.
- Ogni agente usa il suo `OST_DIFF_TAG`, il suo Mailpit (porte 1026–1032 / 8026–8032) e la sua porta per `next dev` (3101–3107).
- Gli agenti non fanno commit. Il coordinatore verifica ogni area in un worktree separato con i soli file di quell'area (lint, typecheck, unit, tutti i diff, build), unisce `docs/contract/<area>.md` nel doc 17, poi fa commit e push.

---

## 5. Punti aperti e decisioni da ricordare

- **Bug PHP non replicati** (sicurezza/permessi): elencati per area nel doc 17 §3 ("Differenze") e nel doc 14. Esempi:
  - `SavedQueue::counts` ignora la visibilità;
  - `Task::checkStaffPerm` mostra a tutti i task chiusi;
  - endpoint dei collaboratori, scollegamento dei ticket e `ajax.schedule.php` senza controlli;
  - reset password del cliente senza controllo di scadenza;
  - strike del cliente legati alla sessione;
  - campi solo-agente accettati dal portale;
  - eliminazione di oggetti referenziati dai filtri (errore fatale del PHP).
- **Testo alternativo delle email** (text/plain): generato con `html-to-text`, può differire nell'impaginazione. HTML, header e Message-ID sono identici.
- **Batch PHP** (cron, fetch email, API REST, installer) e **plugin**: restano al PHP.
- **OAuth2 degli account email**: non gestito. Con un account SMTP OAuth2 Next registra un errore e ripiega su sendmail o `OST_SMTP_URL`.
- **Form con DDL** (`*__cdata`): Next rifiuta le modifiche che richiedono ALTER (`ddl_required`) e le lascia al PHP.
- **Captcha del portale**: non replicato. Con `enable_captcha` attivo gli ospiti non possono aprire ticket da Next.
- **2FA e strike**: codici e contatori sono nella memoria del processo, persi con più istanze o dopo un riavvio.
- **Testo semplice** (rich text disattivato): la chiusura dei tag sbilanciati di `html_balance` non è replicata; la decodifica delle entità sì.
- **IP del client**: si legge da `X-Forwarded-For`, quindi TailTicket va esposto solo dietro il reverse proxy. Nello stack `deploy/` solo Caddy pubblica porte.
- **Cookie di sessione**: `Secure` in produzione, quindi serve HTTPS (localhost escluso). Cookie agenti e cookie clienti (`ostn_client`) sono separati.
- **Sotto-percorso**: `NEXT_BASE_PATH=/app` in fase di build; gli URL scritti a mano passano da `withBase()` (`src/lib/base-path.ts`).
- **Email verso il portale**: i link puntano agli URL del PHP. Lo stack di `deploy/` (Caddy) reindirizza già i link del vecchio portale verso TailTicket (`TAILTICKET_CLASSIC_PORTAL`).
- **Schema osTicket non verificato**: se `core.schema_signature` non è tra quelle in `VERIFIED_SCHEMAS` (`src/server/system/schema-compat.ts`), ogni scrittura è rifiutata (sola lettura). Per una nuova versione di osTicket: aggiornare `legacy/`, far girare i test differenziali, poi aggiungere la firma. Override solo per prove: `TAILTICKET_ALLOW_UNVERIFIED_SCHEMA=1`.
- **Codici dei template negli URL admin**: usano il trattino (`ticket-alert`), perché i percorsi con un punto non passano dal middleware i18n.

## 6. Milestone (riassunto del piano)
- **M0** Fondamenta.
- **M1** Agenti in sola lettura.
- **M2** Scritture sul ticket: risposta/nota, stati, assegnazioni, modifica, merge, delete, massa, export.
- **M3** `Ticket::create` completo e task/utenti/org.
- **M4** Portale clienti.
- **M5** Area admin completa.
- **M6** Hardening e deploy.
- **M7** Fork TailTicket: struttura, brand, documentazione, deploy in un comando, guardia di compatibilità.

Ogni milestone si chiude con:
1. specifica in doc 17;
2. diff test verdi;
3. lint, typecheck e build;
4. commit `paolo-trivi` e push.
