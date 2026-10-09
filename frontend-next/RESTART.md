# RESTART — come riprendere il lavoro su osTicket Next

Aggiornato al 09/10/2026. Branch `claude/nextjs-frontend` → PR https://github.com/paolo-trivi/osticket/pull/1.
I commit hanno autore **paolo-trivi**, **senza righe Co-Authored-By / Claude-Session** (regola fissa).

Obiettivo: nuova app **Next.js** (cartella `frontend-next/`, stile TailAdmin brandizzato osTicket) sullo **stesso DB MySQL di osTicket 1.18.4**. Il pannello PHP deve continuare a funzionare in parallelo, e ogni scrittura di Next deve produrre **le stesse righe** del PHP.

Documenti da leggere prima di toccare codice:
1. `frontend-next/AGENTS.md`: regole del progetto.
2. `frontend-next/docs/parallel-brief.md`: convenzioni, API già pronte, come testare. È il brief usato dagli agenti.
3. `docs/reverse-engineering/00-INDICE.md`: knowledge base di osTicket (doc 00–17).
4. `frontend-next/docs/contract/*.md`: contratto di scrittura per area (`core.md`, `actions.md`), da far confluire nel doc 17.
5. Piano completo delle milestone: `/root/.claude/plans/sorted-leaping-sunrise.md` (se non c'è più, vedi la sezione "Milestone" sotto).

---

## 1. Rimettere in piedi l'ambiente (container nuovo o riavviato)

```bash
cd frontend-next
npm ci

# Opzione A — ambiente di sviluppo completo (osTicket installato da zero + seed)
npm run dev:osticket          # crea /home/user/ost-dev/www e il DB "osticket" (servono MariaDB e PHP 8.3)
php dev/seed.php /home/user/ost-dev/www   # dati di prova (NB: casuali, i test si basano sulla fixture)

# Opzione B — consigliata: stessi dati con cui sono scritti i test (fixture)
OST_DEV=/home/user/ost-dev bash dev/ci-setup.sh   # carica dev/fixtures/osticket-dev.sql.gz e scrive ost-config.php

npm run dev:services          # MariaDB, Mailpit (SMTP 1025 / UI 8025), osTicket PHP su :8080
```

Se il container è stato riavviato basta `npm run dev:services`: i dati persistono in `/home/user/ost-dev` finché il container esiste.

Credenziali (password `Passw0rd!dev` per tutti):
- admin: `devadmin`;
- agenti: `mrossi` (id 2), `lbianchi` (3), `gverdi` (4), `aesposito` (5).

Avvio della app:
```bash
cp .env.example .env.local    # OST_CONFIG_PATH=/home/user/ost-dev/www/include/ost-config.php, APP_SESSION_SECRET, OST_PHP_URL
npm run dev                    # http://127.0.0.1:3000/agent
```

Avvertenze pratiche:
- **Mai** usare `pkill -f …`, perché uccide la shell stessa. Usare `fuser -k <porta>/tcp`.
- In `next dev` l'HMR via 127.0.0.1 a volte non idrata: per le prove E2E usare `next build && next start`.

---

## 2. Verifiche (da fare prima di ogni commit)

```bash
npm run lint && npm run typecheck && npm test        # lint, tipi, unit + integrazione
npx next build                                       # build di produzione

# Test differenziali PHP vs TypeScript: confrontano tutte le tabelle del DB (e le email via Mailpit).
# Ogni area ha DB e Mailpit propri: OST_DIFF_TAG separa i DB (osticket_diff_<tag>_{base,php,ts}).
npm run test:diff                                    # tutti, con DB/Mailpit di default (1025/8025)
OST_DIFF_TAG=actions MAILPIT_SMTP_PORT=1026 MAILPIT_HTTP_PORT=8026 \
  npx vitest run -c vitest.diff.config.mts test/diff/ticket-actions.diff.test.ts
# Mailpit dedicato:
# /home/user/ost-dev/bin/mailpit --smtp 127.0.0.1:1026 --listen 127.0.0.1:8026 --smtp-auth-accept-any --smtp-auth-allow-insecure &

# Cosa scrive il PHP per un'operazione (trace riga per riga):
node test/diff/trace.mjs '{"op":"ticket.reply","args":{"agent":2,"ticket":3,"response":"<p>ciao</p>"}}'
```

CI GitHub Actions (`.github/workflows/frontend-next.yml`): job `quality` (lint, typecheck, unit, build) e job `differential`.
- Il job `differential` installa MariaDB e PHP, ricrea osTicket dalla fixture con `dev/ci-setup.sh` ed esegue `npm run test:diff`.
- **Se cambia il DB di sviluppo** su cui si basano i test, rigenerare la fixture:
  `mysqldump -u root --single-transaction --skip-dump-date --no-tablespaces osticket | gzip -9n > dev/fixtures/osticket-dev.sql.gz`

---

## 3. Stato per milestone

| Milestone | Stato | Note |
|---|---|---|
| M0 Fondamenta | ✅ | scaffold, DB Kysely, config, login agenti, harness, branding, tema da admin |
| M1 Agenti sola lettura | ✅ | code/contatori/visibilità, ricerca, vista ticket, utenti/org, KB, canned, task, profilo, dashboard |
| M2.1/M2.2 Scritture base | ✅ | nota, risposta, stato, lock, eventi, `_search`, mailer, crypto, SLA, composer UI — diff 7/7 + SLA 5/5 |
| M2.3 A — azioni ticket ("actions") | 🟡 quasi finito | diff **33/33 verdi**; UI da rifinire e verificare |
| M2.3 B — modifica ticket ("ticketedit") | ⬜ da fare | |
| M3 A — creazione ticket + allegati ("create") | 🟡 in corso | servizi scritti, **nessun diff test**, niente pagina `/agent/tickets/new` |
| M3 B — task/utenti/org/profilo ("people") | 🟡 in corso | task: diff **10/10 verdi**; directory/profilo/2FA da fare |
| M4 Portale clienti ("portal") | ⬜ da fare | |
| M5 A — admin impostazioni/reparti/agenti ("admin") | ⬜ da fare | menu admin già completo (`admin/layout.tsx`) |
| M5 B — admin email/filtri/form/code/log ("adminsys") | ⬜ appena iniziato | solo `test/diff/php/ops/adminsys.php` (3 operazioni) |
| M6 Deploy/CI/hardening | ✅ (base) | CI verde, Dockerfile, compose, nginx `/app`, basePath, CSP con nonce |

### Dettaglio del lavoro lasciato a metà (commit "WIP" di chiusura)

Gli agenti si sono fermati qui. Il codice compila (typecheck, lint e build verdi), ma va completato.

**actions** (M2.3 A):
- File:
  - `src/server/domain/ticket/{assign,transfer,ticket-state,alerts}.ts`;
  - `src/app/[locale]/(staff)/agent/(panel)/tickets/[id]/actions-assign.ts`;
  - `src/components/tickets/TicketActionsMenu.tsx` + `src/components/tickets/actions/*`;
  - testi in `src/messages/actions/*`;
  - `test/diff/ticket-actions.diff.test.ts` (33 verdi) + `test/diff/php/ops/actions.php`;
  - `docs/contract/actions.md`.
- Da fare: verificare a mano la UI (dropdown e modali) nella vista ticket, controllare i testi `actions` it/en, completare `docs/contract/actions.md`.

**create** (M3 A):
- File:
  - `src/server/domain/ticket/{create,create-alerts,create-number,create-user}.ts`;
  - `src/server/domain/filter/ticket-filter.ts`;
  - `src/server/domain/forms/{entry,fields,load}.ts`;
  - `src/server/domain/file/upload.ts`;
  - `test/diff/php/ops/create.php`;
  - modifiche additive in `thread/write.ts` (allegati, `editorSpacing`) e `ticket/post.ts` (allegati della risposta nelle email).
- Da fare:
  - `test/diff/ticket-create.diff.test.ts`: agente/web, topic e form, filtri, numerazione, SLA, auto-risposte e alert via Mailpit, allegati;
  - pagina `/agent/tickets/new` con i form dinamici (`src/components/forms/dynamic/*`);
  - input allegati nel `TicketComposer`.
- L'agente si era fermato mentre correggeva `create.ts`.

**people** (M3 B):
- File:
  - `src/server/domain/task/{model,vars,write}.ts`;
  - `src/server/domain/directory/forms.ts`;
  - `test/diff/tasks.diff.test.ts` (10 verdi);
  - `test/diff/php/ops/people.php` (34 operazioni, anche directory e profilo).
- Da fare:
  - UI delle azioni sui task (`/agent/tasks/**`);
  - CRUD utenti/org con import CSV e account;
  - profilo agente: preferenze, cambio password, reset password;
  - **2FA email** al login: oggi `staff-auth.ts` restituisce `mfa_unsupported`;
  - alert all'admin per troppi login falliti;
  - diff test di directory e profilo.

---

## 4. Ripartire con gli agenti in parallelo

Gli agenti lavorano **nella stessa cartella**, ciascuno solo sui file della propria area: la tabella delle proprietà è nel brief e nei prompt.
- Lanciarli **a ondate di massimo 3**. Con 8 insieme si è raggiunto il limite di sessione dell'API (errore 429) e si sono fermati tutti.
- Ogni agente riceve come prima istruzione: *"Leggi PRIMA e per intero `frontend-next/docs/parallel-brief.md` e `frontend-next/AGENTS.md`"*, poi il compito della sua area con tag e porte.

| Area | OST_DIFF_TAG | Mailpit SMTP/HTTP | Compito |
|---|---|---|---|
| actions | actions | 1026 / 8026 | completare (vedi sopra) |
| ticketedit | ticketedit | 1027 / 8027 | Ticket::update/editField + cdata + `_search`; collaboratori; merge/link; delete (collegare `hardDelete` di `setTicketStatus`); azioni di massa; export CSV; modifica voce del thread. Slot UI: `TicketExtraActions.tsx` |
| create | create | 1028 / 8028 | completare (vedi sopra) |
| people | people | 1029 / 8029 | completare (vedi sopra) |
| portal | portal | 1030 / 8030 | portale clienti in `src/app/[locale]/(client)/**`: login/registrazione/reset/guest/link con token, lista e vista ticket, `postMessage` (`src/server/domain/ticket/message.ts`), KB, apertura ticket con `createTicket` |
| admin | admin | 1031 / 8031 | `/admin/settings/{company,system,tickets,tasks,agents,users,kb}`, departments, topics, sla, schedules, agents, teams, roles, dashboard `/admin` |
| adminsys | adminsys | 1032 / 8032 | emails (+ password cifrate con `encrypt()`), settings/emails, banlist, templates, diagnostic, filters, forms, lists, pages, queues, apikeys, logs, system, plugins |

Ordine consigliato:
1. `actions`, `create`, `people`: finire quanto già iniziato.
2. `ticketedit`, `portal`, `admin`.
3. `adminsys`.

Dopo ogni ondata il coordinatore:
- legge i report;
- integra le dipendenze tra aree: voci nel menu agenti `agent/nav.tsx`, `hardDelete`, `createTicket` nel portale, allegati nel composer;
- unisce `docs/contract/<area>.md` nel doc 17;
- esegue tutte le verifiche (§2);
- fa commit e push.

### Prompt tipo per un agente
> Leggi PRIMA e per intero /home/user/osticket/frontend-next/docs/parallel-brief.md e /home/user/osticket/frontend-next/AGENTS.md, poi /home/user/osticket/frontend-next/RESTART.md (stato del lavoro). AREA: "<area>" — OST_DIFF_TAG=<tag>, Mailpit SMTP <porta>/HTTP <porta> (avvialo tu). COMPITO: <riga della tabella sopra, più i "da fare" del §3>. Replica il PHP riga per riga (include/class.*.php, scp/*.php, include/ajax.*.php); test differenziali obbligatori in test/diff/<area>*.diff.test.ts con ops PHP in test/diff/php/ops/<area>.php; non fare commit; non toccare file di altre aree; report finale come da brief.

---

## 5. Punti aperti e decisioni da ricordare

- **Bug PHP non replicati** (sicurezza/permessi): `SavedQueue::counts` ignora la visibilità; `Task::checkStaffPerm` mostra a tutti i task chiusi. Sono documentati nel doc 14 e nei commenti del codice.
- **Il testo alternativo delle email** (text/plain) è generato con `html-to-text` e può differire nell'impaginazione dal `html2text` PHP. HTML, header e Message-ID invece sono identici. I test confrontano solo la presenza di `Ref-Mid`.
- **Batch PHP** (cron, fetch email, API REST, installer) restano al PHP e non vanno duplicati in Next.
- **OAuth2 degli account email**: Next non lo gestisce. Con un account SMTP OAuth2 registra un errore e ripiega su sendmail o `OST_SMTP_URL`.
- **IP del client**: si legge da `X-Forwarded-For`, quindi Next va esposto solo dietro il reverse proxy. Il compose lo pubblica su 127.0.0.1.
- **Cookie di sessione**: `Secure` in produzione, quindi serve HTTPS (localhost escluso).
- **Pubblicazione in un sotto-percorso**: `NEXT_BASE_PATH=/app` in fase di build; gli URL scritti a mano passano da `withBase()` (`src/lib/base-path.ts`).
- **Fine lavori**: aggiornare `frontend-next/README.md` (funzioni, deploy, CI) e la descrizione della PR #1 con lo stato delle milestone e i limiti noti.

## 6. Milestone (riassunto del piano)
- **M0** Fondamenta.
- **M1** Agenti in sola lettura.
- **M2** Scritture sul ticket: risposta/nota, stati, assegnazioni, modifica, merge, delete, massa, export.
- **M3** `Ticket::create` completo e task/utenti/org.
- **M4** Portale clienti.
- **M5** Area admin completa.
- **M6** Hardening e deploy.

Ogni milestone si chiude con:
1. specifica in doc 17;
2. diff test verdi;
3. lint, typecheck e build;
4. commit `paolo-trivi` e push.
