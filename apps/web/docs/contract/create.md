# Contratto di scrittura — area "create" (M3 A: creazione ticket e allegati)

Riferimenti PHP: `include/class.ticket.php` (Ticket::create, Ticket::open, filterTicketData, onNewTicket,
onOpenLimit, postCannedReply, assign/assignToStaff/assignToTeam), `class.filter.php`, `class.filter_action.php`,
`class.dynamic_forms.php`, `class.forms.php`, `class.file.php`, `class.user.php`, `class.list.php`,
`scp/tickets.php` (a=open), `open.php`.
Diff test: `test/diff/ticket-create.diff.test.ts` (43 scenari) con le op di `test/diff/php/ops/create.php`.

## API

```ts
// src/server/domain/ticket/create.ts — da eseguire dentro runWrite()
createTicket(ctx: WriteContext, input: CreateTicketVars, origin: "staff" | "web",
             opts?: { autorespond?: boolean; alertstaff?: boolean }): Promise<CreateResult>
// src/server/domain/ticket/create-open.ts — Ticket::open (agente)
openTicket(ctx: WriteContext, input: OpenTicketInput, opts?: CreateOptions): Promise<CreateResult>

type CreateResult =
  | { ok: true; ticketId: number; number: string; messageId: number | null; threadId: number }
  | { ok: false; errors: CreateErrors };   // {err?, errno?, topicId?, deptId?, duedate?, source?, user?, email?, name?, assignId?, fields?: {idCampo: codici[]}}
```

`CreateTicketVars` = `$vars` del PHP: `uid` | (`email`, `name` e gli altri campi del form utente per nome),
`topicId`, `deptId`, `slaId`, `statusId`, `duedate` (solo staff), `source`, `subject`, `message` (HTML),
i campi dei form dinamici **per nome o per id**, `ccs` (id utenti), `files` (`{id, name}[]` già verificati),
`ip`, `priority` (campo del form), `emailId`.

Uso dal **portale** (open.php): `runWrite({ actor }, ctx => createTicket(ctx, { ...vars, uid, ip, deptId: 0, emailId: 0 }, "web"))`
con `actor = { kind: "user", id, name, email, hasAccount, ip }` per il cliente autenticato, `null` per un ospite
(l'IP va passato in `vars.ip`). Gli allegati arrivano da un endpoint di upload del portale (da creare, stessa
logica di `src/app/api/agent/upload/route.ts`) con `signUploadToken(id, nome, "U<uid>" | "G<sessione>")` e si
verificano con `verifyUploadTokens(tokens, owner)`. Il portale deve anche eliminare le bozze
`ticket.client.<ultimi 12 caratteri della sessione>` (open.php).

Moduli di supporto di `createTicket` (che resta intera in `create.ts`): argomento, form del topic e priorità
(`ticket/create-topic.ts`); `filterTicketData` (`ticket/create-filter.ts`); auto-assegnazione e assegnazione dal
form di apertura (`ticket/create-assign.ts`); collaboratori e destinatari (`ticket/create-collab.ts`); utente e
ticket aperti dell'utente (`ticket/create-user.ts`). Filtri: selezione e regole in `filter/ticket-filter.ts`, azioni
in `filter/ticket-filter-actions.ts`.

Altre API: `uploadFile`, `createAttachmentFile`, `attachFilesToEntry`, `signUploadToken`, `verifyUploadTokens`,
`threadUploadRules` (`file/upload.ts`); `postCannedReply` (`ticket/create-canned.ts`); `sendFilterEmail`,
`onOpenLimit`, `onNewTicket`, `onAssignAlert`, `sendNewTicketNotice` (`ticket/create-alerts.ts`);
`formView`, `baseForms`, `topicFormsView`, `openTicketOptions`, `searchUsers`, `usersByIds`, `formDataToVars`
(`ticket/create-ui.ts`); `FormInstance`, `saveFormEntry`, `ensureListPropertiesForm` (`forms/entry.ts`);
`phpParseDateTime`, `phpTzAbbr` (`forms/field-dates.ts`), `phpFormatDate` (`format/datetime.ts`); `prepareSupportedMatches`
(`filter/ticket-filter.ts`); `adminAlertMail`, `logWithAdminAlert` (`system/admin-alert.ts`).

## Ordine delle scritture (Ticket::create)

1. Validazione (`Validator::process` per origine, scadenza, form). Errori → nessuna scrittura.
2. `filterTicketData` (1° passaggio): dati filtro dei form (`field.<id>`, liste `field.<id>.abb`/proprietà),
   utente/organizzazione, ban list (`SYSTEM BAN LIST`) e `new TicketFilter` → **effetto collaterale**:
   `form` `L<lista>` "<Lista> Properties" creato per ogni campo lista dei form U, T, G, O se manca
   (DynamicList::getForm autocreate). Rifiuto → `syslog` Warning "Ticket denied" (senza avviso admin), `errno 403`.
3. Limite `max_open_tickets` (non staff): superato → `syslog` Warning "Ticket denied - <email>".
4. Utente nuovo (`User::fromVars`): `user_email` (user_id 0) → `user` (org per dominio) → `user_email.user_id`
   → `form_entry` U + `form_entry_values` + `user__cdata` → `_search` U.
5. `sequence` (FOR UPDATE, `next += increment`, `updated = NOW()`) se numerazione sequenziale; altrimenti numero casuale
   (≥ 6 cifre) unico; formato del topic se `FLAG_CUSTOM_NUMBERS`.
6. `ticket` (created/lastupdate/updated NOW, number, user, dept, topic, ip, source, email_id, duedate staff), `thread`.
7. `form_entry` T (sort = posizione del form nel topic, `extra` `{"disable":[...]}`) + valori + `ticket__cdata`
   (solo form di tipo T); form del topic (tipo G) senza cdata. `_search` T (titolo "numero oggetto", risposte ordinate per `field.sort`).
8. `thread_event` created (uid dell'agente o dell'utente proprietario).
9. `status_id` = default (1) se 0.
10. Collaboratori `ccs` (`thread_collaborator` flag 3, evento `collab` `{"add":{id:{name}}}`), collaboratori dell'organizzazione
    (tutti o contatti primari) con evento `collab` `{"org":id}`.
11. Messaggio (`thread_entry` M, recipients JSON, flag, `_search` H, `attachment` H), `thread.lastmessage`, ticket non risposto.
12. `filterTicketData` (2° passaggio): azioni `email` dei filtri (email inviate), eventi `edited` con descrizione per ogni azione.
13. `thread_entry.flags |= ORIGINAL_MESSAGE`.
14. SLA (`selectSLAId`: vars → reparto → topic → default), stato (`setStatus`, chiusura con evento `closed`, referral).
15. Assegnazione solo se aperto: `assignId` del form (eventi `assigned`, nota "Ticket Assigned to …"/"claimed by"
    con i commenti, `assigned.alert`) oppure staff/team da topic, filtri o account manager (username evento "Ticket Filter").
16. `est_duedate` (`updateEstDueDate`).
17. Risposta predefinita da filtro (`postCannedReply`): `thread_entry` R "SYSTEM (Canned Reply)" con allegati della
    canned, `isanswered` 1 poi 0, `ticket.autoreply` (disattiva l'auto-risposta).
18. `onNewTicket`: `ticket.autoresp` all'utente (se autoresponder di sistema e reparto) e `ticket.alert` (membri,
    manager del reparto, account manager, admin).
19. Limite appena raggiunto: `onOpenLimit` → `syslog` + avviso admin, `ticket.overlimit` all'utente, "Overlimit Notice" all'admin.

`Ticket::open` (agente) aggiunge: risposta iniziale (`postReply` con allegati `responseFiles`, `source` del ticket),
nota "New Ticket" se non c'è assegnazione, `ticket.notice` (messaggio + risposta, firma, allegati) e — come
`scp/tickets.php` — la cancellazione delle bozze `ticket.staff%` dell'agente.

Upload (ajax `FileUploadField::ajaxUpload`): `file` (type minuscolo, nome sanificato, key casuale, signature
`sha1[0..16]+md5[0..16]`, ft T) + `file_chunk` da 500 KiB, poi `bk='D'`, `attrs=NULL`; deduplica per firma e dimensione.

## Email (verificate via Mailpit)
`ticket.alert`, `ticket.autoresp`, `ticket.notice`, `ticket.reply`, `ticket.autoreply` (canned), `assigned.alert`,
`ticket.overlimit`, avvisi admin solo testo ("Maximum Open Tickets Limit", "Overlimit Notice"), email dei filtri.

## Differenze rispetto al PHP
- **Sicurezza (non replicato)**: dal portale si accettano solo i campi visibili ai clienti (il PHP salva anche i campi
  solo-agenti inviati in POST); in `Ticket::open` un reparto senza accesso (ruolo "solo creazione", `__new__`) non
  consente l'assegnazione; gli allegati richiedono un token firmato del proprietario (al posto di `$_SESSION[':uploadedFiles']`).
- `file.key` è casuale come nel PHP (prefisso da microtime): i test lo ignorano.
- FA_SendEmail: il PHP passa `"Nome" <email>` come stringa e il nome arriva codificato con le virgolette; qui senza.
- Canned response con immagini `cid:`: `Format::viewableImages` non replicato.
- Estensione del telefono: il PHP la legge solo con il nome "hash" del campo; Next la legge da `<nome>-ext`.
- Formato delle date (`%{ticket.create_date}` di FormattedDate e testo dei campi data per filtri e indice): un'unica
  implementazione di Format::date/datetime/time/daydatetime, `phpFormatDate` in `server/format/datetime.ts` (formati ICU
  della lingua di sistema con U+202F prima di AM/PM come ICU >= 72, pattern della config con `date_formats = custom`); la
  modalità `date_formats = 24` non è gestita.

## Stranezze PHP replicate
- Scadenza e date dei campi interpretate in UTC (default di bootstrap.php) anche senza offset; la UI invia ISO con offset.
- Topic esistente ma disattivato: `topicId` azzerato ma il topic resta in uso (reparto, priorità, numerazione, form).
- Datetime dei form salvati come `Y-m-d H:i:s T` nel fuso dell'utente (es. `2026-09-30 02:00:00 CEST`).
- Memo non trimmato; `$thisclient` (EndUser) non dà uid negli eventi (uid NULL, uid_type S); username dell'evento
  `created` dal portale = nome dell'utente; `FA_SetStatus` descrive lo stato cercando un Team.
- Creazione automatica del form proprietà delle liste (vedi punto 2).
- Il messaggio di sistema `ticket.alert` non ha token/separatore (thread non è una ThreadEntry).
- htmLawed `tidy=-1`: spazi compattati in `Format::safe_html` (ora replicato in `safeHtml`).
