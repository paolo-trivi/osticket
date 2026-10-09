# Brief per il lavoro in parallelo (agenti)

Progetto: `/home/user/osticket/frontend-next`. È un'app Next.js 16 (App Router), React 19, TypeScript strict, Tailwind v4, stile TailAdmin brandizzato osTicket. Lavora sullo **stesso DB MySQL di osTicket 1.18.4**, il cui codice PHP originale è in `/home/user/osticket` (`include/`, `scp/`, client in root). Il PHP deve continuare a funzionare in parallelo sugli stessi dati.

Lingua: italiano per commenti, documentazione e risposte.

## Regole che non si violano
1. **Nessun DDL** sul DB (niente tabelle nuove, ALTER, migrazioni). La config propria di Next va solo in righe `config` con namespace `nextui.*`.
2. **Ogni scrittura riproduce esattamente le righe del PHP**, inclusi gli effetti collaterali: `thread_event`, `_search`, `*__cdata`, `form_entry(_values)`, `attachment/file/file_chunk`, `lock`, `sequence`, `syslog`, `draft`, `updated = NOW()` solo quando il PHP marca il modello come modificato.
   - Stesse stranezze e bug del PHP: si replicano e si annotano nel commento.
   - Eccezione: i bug di **sicurezza/permessi** non si replicano. Si applica la regola più stretta e la si annota.
3. Datetime scritti con `NOW()` lato SQL (`NOW` da `src/server/db`). Datetime calcolati in formato `Y-m-d H:i:s` nel fuso del DB (`detectDbTimezone`). JSON come `json_encode` PHP (`phpJsonEncode` in `src/server/format/php-json.ts`). HTML sanificato con `safeHtml`/`sanitizeText` (`src/server/format/sanitize.ts`, `text.ts`).
4. Batch job (cron, fetch email, API REST `/api/*.php`, installer) **restano al PHP**: non duplicarli.
5. **Non fare commit né push** e non toccare git: i commit li fa il coordinatore.
6. Lavora **solo sui file della tua area** (tabella sotto). Sui file condivisi "core" sono ammesse solo piccole aggiunte additive, ad esempio una nuova funzione esportata. Mai riscritture: altri agenti lavorano in contemporanea nella stessa directory.

## Ambiente di sviluppo (già attivo)
- MariaDB locale: `mysql -u root`. DB di sviluppo `osticket`, prefisso tabelle `ost_`.
- osTicket PHP: `/home/user/ost-dev/www`, servito su `http://127.0.0.1:8080`.
  - Admin: `devadmin` / `Passw0rd!dev`.
  - Agenti (password `Passw0rd!dev`): `mrossi` (id 2), `lbianchi` (3), `gverdi` (4), `aesposito` (5).
  - Dati seed: 61 ticket, 12 utenti, 5 organizzazioni, task, KB.
- Mailpit condiviso: SMTP 1025, UI/API 8025. **Ogni agente avvia il proprio** sulle porte assegnate, ad esempio area `actions`:
  `nohup /home/user/ost-dev/bin/mailpit --smtp 127.0.0.1:1026 --listen 127.0.0.1:8026 --smtp-auth-accept-any --smtp-auth-allow-insecure >/tmp/mailpit-actions.log 2>&1 &`
- **Mai** usare `pkill -f <pattern>`: uccide la propria shell. Usare `fuser -k <porta>/tcp`.

## Test differenziali PHP vs TypeScript (obbligatori per ogni scrittura)
- **Harness** (`test/diff/lib/harness.ts`): `prepareSnapshot`, `resetWorkingDatabases`, `runPhp(op)`, `compareWorkingDatabases()` (risultato atteso `[]`), `execBoth(...sql)` per preparare lo stesso stato su entrambi i DB (`{p}` = prefisso).
- **Email**: `test/diff/lib/mailpit.ts` → `mailsOf(() => operazione, nAttese)` restituisce le email normalizzate (Message-ID decodificato, header RFC 2047 decodificati); confronta con `expect(tsMails).toEqual(phpMails)`. Esempio completo: `test/diff/ticket-post.diff.test.ts` (7 scenari verdi).
- `TicketRecord.save()` reindicizza già il ticket in `_search` (Signal model.updated del PHP): non duplicarlo.
- **Isolamento**: ogni area usa DB e Mailpit propri tramite variabili d'ambiente:
  `OST_DIFF_TAG=<area> MAILPIT_SMTP_PORT=<smtp> MAILPIT_HTTP_PORT=<http> npx vitest run -c vitest.diff.config.mts test/diff/<file>.diff.test.ts`
  (DB `osticket_diff_<area>_{base,php,ts}`; il mailer TS consegna allo stesso Mailpit tramite `OST_SENDMAIL_PATH`, già impostato da `vitest.diff.config.mts`).
- **Operazioni PHP del runner**: **non** modificare `test/diff/php/runner.php`. Crea `test/diff/php/ops/<area>.php` registrando closure: `$OPS['ticket.assign'] = function (array $op) { ...; return ['ok' => true, ...]; };`.
  - Il bootstrap osTicket è già fatto: sono disponibili `$GLOBALS['cfg']` e tutte le classi.
  - Per l'agente corrente: `$GLOBALS['thisstaff'] = Staff::lookup($op['args']['agent']);`.
  - Vedi gli esempi `ticket.note`/`ticket.reply` in `runner.php`.
- **Trace delle scritture PHP** (cosa scrive un'operazione):
  `OST_DIFF_TAG=<area> MAILPIT_SMTP_PORT=<smtp> node test/diff/trace.mjs '{"op":"...","args":{...}}'`.

## API già pronte (usale, non duplicarle)

**Transazione e contesto**
- `runWrite({agent, ip}, async (ctx) => ...)` in `src/server/domain/write.ts`: transazione più `WriteContext` `{tx, cfg (core), actor, agent, dbZone, after[]}`. Le email vanno in `ctx.after` (partono dopo il commit).

**Ticket**
- `TicketRecord` (`src/server/domain/ticket/record.ts`): `load(tx, id, forUpdate)`, `set(campo, valore | SQL_NOW)`, `save(refetch)`. Replica il "dirty tracking" dell'ORM PHP e `updated=NOW()` di `Ticket::save`.
- `logTicketEvent(tx, row, threadId, actor, state, data, who?, annul?)` e `logThreadEvent` (`events.ts`): `thread_event` come `ThreadEvents::log`.
- `status.ts`:
  - `setTicketStatus` (Ticket::setStatus), `clearOverdue`, `updateEstDueDate`;
  - `referThreadToStaff`, `lastRespondentId`, `setStaffId`;
  - `isCloseable`, `roleOnRow`, `isAssignedRow`, `loadStatus`, `DeptFlag`, `TopicFlag`.
- `post.ts`: `postNote`, `postReply`, `logNote`, `onActivity`, `ticketThreadId`.
- `lock.ts`: lock dei ticket. `collab.ts`: collaboratori, ban list, bozze.
- `ticket.ts` (lettura): `loadTicket`, `checkStaffPerm`, `roleOn`, `loadThreadEntries`…
- Thread: `createThreadEntry`, `threadOf`, `lastMessage`, `touchThread` (`src/server/domain/thread/write.ts`).

**Indice di ricerca**
- `replaceSearchRow` / `deleteSearchRow` (`src/server/domain/search/index-writer.ts`).

**Email e template**
- `sendMail(OutgoingMail)` (`src/server/mail/mailer.ts`): Message-ID firmato, SMTP con credenziali decifrate o sendmail.
- `loadMsgTemplate` / `templateGroupFor` (`mail/templates.ts`).
- `VariableReplacer` (`mail/variables.ts`).
- Oggetti per i template (`mail/objects.ts`): `buildTicketVars`, `staffVar`, `companyVar`, `entryVar`, `deptVar`, `contactVar`, `ticketLink`.

**Altre utilità**
- Cifratura compatibile (`src/server/crypto/crypto.ts`): `encrypt`/`decrypt`, AES con `SECRET_SALT`.
- Message-ID e token (`mail/message-id.ts`): `buildMessageId`, `decodeMessageId`, `ticketAuthToken`, `base32Encode/Decode`, `randCode`.
- Formattazione:
  - `PersonsName` (`src/server/format/persons-name.ts`);
  - `cleanEntryBody`, `searchable`, `htmlSearchable`, `stripEmoticons`, `sanitizeText` (`format/text.ts`).
- Agente e permessi (`src/server/domain/staff/staff.ts`):
  - `loadAgent`;
  - `Agent` (`roleFor`, `canAccessDept`, `hasGlobalPerm`, `isAvailable`, `config`…);
  - costanti `TicketPerm`, `TaskPerm`, `GlobalPerm`.
- Config:
  - `loadConfigNamespace(ns, executor, defaults)`, `coreConfig()` (`src/server/config/config.ts`);
  - scrittura stile `Config::set` in `src/server/theme/theme.ts` (`saveTheme`, upsert).
- DB:
  - `db()` (Kysely, nomi tabella senza prefisso), `table(name)` per SQL raw (`sql\`... ${table("ticket")} ...\``), `NOW`, `type DbOrTx`;
  - tipi generati in `src/server/db/schema.gen.ts`.
- Syslog: `logSystem(level, title, msg, ip)` (`src/server/system/syslog.ts`).
- SLA (in arrivo da un altro agente): `slaDueDate({slaId, deptId, start}, executor)` in `src/server/domain/sla/sla.ts`.

## UI
- Componenti TailAdmin in `src/components/**`: `ComponentCard`, `DataTable` (+ `PageHeader`, `SearchBox`, `Forbidden`), `Badge`, `Button`, `Modal`, form (`InputField`, `Select`, `TextArea`, `Checkbox`, `Switch`), `RichTextEditor` (`src/components/editor`).
  - Esempi di pagine: `src/app/[locale]/(staff)/agent/(panel)/**` e `src/app/[locale]/(staff)/admin/theme/*` (form con server action).
- Protezione delle pagine:
  - agenti: `requireAgent(locale)` (`src/app/[locale]/(staff)/agent/guard.ts`) in **ogni** page;
  - admin: `requireAdmin(locale)` (`admin/guard.ts`).
  - Server action: ricontrollare sempre sessione e permessi (`currentAgent()` da `src/server/auth/staff-auth.ts`).
- Testi: next-intl, lingue `it` (default) ed `en`.
  - **Ogni area scrive solo** in `src/messages/<area>/it.json` e `en.json`, con namespace propri; i file base `src/messages/it.json`/`en.json` non vanno toccati.
  - `useTranslations("<ns>")` / `getTranslations("<ns>")`.
- Navigazione: il menu admin è già completo (`admin/layout.tsx`, con link a `/admin/settings/*`, `/admin/topics`, …): crea le pagine a quei percorsi.
  - Il menu agenti (`agent/nav.tsx`) è del coordinatore: chiedi nel report se serve una voce nuova.

## Verifica prima di dichiarare finito
- Typecheck: `npx tsc --noEmit -p .`. Considera solo gli errori nei tuoi file, gli altri agenti hanno lavori in corso.
- Lint: `npx eslint <tuoi percorsi>`.
- Test: i tuoi test differenziali verdi (con il tuo `OST_DIFF_TAG`) e gli eventuali unit test (`npx vitest run test/unit/<file>`).
- **Non** eseguire `next build` (lo fa il coordinatore) e non avviare `next dev` sulla porta 3000 (usa una porta tua se serve).
- Specifica delle scritture: scrivila in `docs/contract/<area>.md` (tabelle e colonne toccate, valori, eventi, email), confluirà nel doc 17.

## Report finale
Nel messaggio finale riporta:
- file creati e modificati;
- API esportate;
- operazioni coperte;
- test (quanti, tutti verdi?);
- differenze/bug PHP trovati;
- cosa resta da fare;
- voci di menu o integrazioni che il coordinatore deve aggiungere.
