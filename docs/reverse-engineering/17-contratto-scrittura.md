# 17 — Contratto di scrittura (coesistenza PHP ↔ Next.js)

Questo documento elenca, **operazione per operazione**, le righe che osTicket PHP scrive nel database. La nuova app Next.js (`apps/web/`) deve produrre **le stesse righe**, così il pannello PHP continua a funzionare sugli stessi dati.

Ogni voce è verificata dall'**harness differenziale** (`apps/web/test/diff/`, comando `npm run test:diff`):
1. si clona il DB di sviluppo in uno snapshot;
2. la stessa operazione viene eseguita con il codice PHP originale (`test/diff/php/runner.php`) su una copia e con il servizio TypeScript sull'altra;
3. si confrontano tutte le tabelle, con i datetime "recenti" normalizzati a `<NOW>`.

Una nuova operazione si considera conforme solo quando ha uno scenario differenziale verde.

## 0. Regole generali (valgono per ogni scrittura)

| Regola | Origine PHP | Implementazione TS |
|---|---|---|
| Sessione MySQL: `NAMES utf8`, `COLLATION_CONNECTION utf8_general_ci`, `SQL_MODE=''`, `TIME_ZONE='SYSTEM'` | `include/mysqli.php` `db_connect()` | `src/server/db/index.ts` (`SESSION_INIT`) |
| `created`/`updated`/`lastlogin`… valorizzati con `NOW()` lato SQL | `SqlFunction::NOW()` | costante `NOW` |
| Date calcolate (scadenze SLA ecc.) in formato `Y-m-d H:i:s` nel **fuso del DB** | `Ticket::getSLADueDate()` | `toDb()` in `src/server/db/time.ts` |
| JSON codificati come `json_encode()` di PHP (`\/`, `\uXXXX`) | `JsonDataEncoder::encode` | `phpJsonEncode()` |
| Nessun carattere a 4 byte (tabelle utf8 a 3 byte) | `Format::strip_emoticons` + charset | `stripFourByteChars()` |
| Password: bcrypt `$2a$08$` (phpass); MD5 legacy riconvertito al primo login | `Passwd`, `Staff::check_passwd` | `src/server/auth/passwd.ts` |
| La tabella `session` (sessioni HTTP PHP) **non** è condivisa: Next usa cookie firmati propri | `class.ostsession.php` | `src/server/auth/session.ts` |
| Nuovi dati di configurazione della app Next: solo **righe** in `config` con namespace `nextui.*` (mai tabelle nuove) | `Config` (namespace come per i plugin) | `src/server/theme/theme.ts` |

## 1. Operazioni implementate

### 1.1 Login agente riuscito — `StaffAuthenticationBackend::process` → `login()`
| Tabella | Scrittura |
|---|---|
| `staff` | `extra` = JSON esistente + `browser_lang` (lingua corrente: `staff.lang` o `core.system_language`); `lastlogin = NOW()`; `updated = NOW()` (`Staff::onLogin`, `Staff::save` imposta `updated` se il record è modificato) |
| `staff` | se l'hash era MD5: `passwd` = nuovo bcrypt (`check_passwd`) |
| `config` | `DELETE WHERE namespace='pwreset' AND value=<staff_id>` (`cancelResetTokens`) |
| `syslog` | solo se `core.log_level >= 3`: riga `Debug`, titolo `Agent Login`, testo `<username> logged in [<ip>], via osTicketStaffAuthentication`, `logger=''` |

Scenari differenziali: login con username, login con email, log di debug attivo → **identici**.

### 1.2 Login agente fallito — `StaffAuthStrikeBackend::authStrike`
| Condizione | Scrittura |
|---|---|
| tentativi ≤ `staff_max_logins` e non multipli di 3 | nessuna |
| ogni 3° tentativo | `syslog` `Warning` "Failed agent login attempt (<username>)" (se `log_level >= 2`) |
| tentativi > `staff_max_logins` | `syslog` `Warning` "Excessive login attempts (<username>)" + blocco per `staff_login_timeout` minuti; email all'admin se `send_login_errors` (**da fare**: richiede il mailer, M2) |

Differenza voluta: il PHP conta i tentativi nella sessione (aggirabile scartando il cookie, doc 14 §2.3); Next li conta per IP + username, in memoria. Il DB non cambia.
Scenario differenziale: password errata → **nessuna scrittura** da entrambe le parti.

### 1.3 Logout agente
| Tabella | Scrittura |
|---|---|
| `syslog` | solo se `log_level >= 3`: `Debug` "Agent logout", `<username> logged out [<ip>]` |

### 1.4 Tema della nuova interfaccia (solo Next)
| Tabella | Scrittura |
|---|---|
| `config` | namespace `nextui.theme`, una riga per chiave: `primary_color`, `mode_default`, `allow_user_mode`, `sidebar_style`, `font`, `radius`, `density`, `app_name`, `login_tagline`, `use_osticket_logos`; insert se manca, update di `value` e `updated=NOW()` solo se cambia (stessa semantica di `Config::set`) |

Il PHP non legge questo namespace. I loghi **non** vengono duplicati: si usano `core.staff_logo_id`, `core.client_logo_id`, `core.staff_backdrop_id`, gestiti dal pannello classico.

### 1.5 Letture verificate (M1)
Code dei ticket: per ogni agente e coda la nuova app mostra **gli stessi ticket nello stesso ordine** del PHP (`test/diff/queues.diff.test.ts`, confronto con `CustomQueue::getQuery` + `Staff::getTicketsVisibility` + ordinamenti di `queue-tickets.tmpl.php`). Divergenza voluta: i contatori rispettano la visibilità (in PHP 1.18.4 no, vedi doc 14 §2).

## 2. Copertura per milestone

Tutte le operazioni del backlog iniziale sono implementate in Next e coperte da scenari differenziali (`apps/web/test/diff/`, 308 scenari). Il dettaglio delle righe scritte è nella §3, area per area.

| Milestone | Operazioni | Metodi PHP di riferimento | Contratto |
|---|---|---|---|
| M2 ✅ | risposta, nota, cambio stato, lock, bozze, allegati | `Ticket::postReply`, `postNote`, `setStatus`, `Lock::acquire`, `Draft`, `AttachmentFile` | §3.1 |
| M2 ✅ | assegnazione, claim, rilascio, trasferimento, referral, segna risposto | `Ticket::assign`, `claim`, `release`, `transfer`, `refer`, `markAnswered` | §3.2 |
| M2 ✅ | modifica campi, proprietario, collaboratori, merge/link, cancellazione, scaduto, ban, massa, export, modifica voce | `Ticket::update`, `updateField`, `merge`, `link`, `delete`, `markOverdue`, `Export::saveTickets`, `ThreadEntry::edit` | §3.3 |
| M3 ✅ | creazione ticket (agente e web), filtri, numerazione, form dinamici | `Ticket::create`, `Ticket::open`, `Filter::apply` | §3.4 |
| M3 ✅ | task, utenti, organizzazioni, profilo, 2FA, reset password agenti | `Task::*`, `User::fromVars`, `UserAccount::register`, `Organization::*`, `Staff::*` | §3.5 |
| M4 ✅ | portale: login, registrazione, reset, ospite, messaggio, apertura, profilo | `UserAccount`, `ClientPasswordResetTokenBackend`, `Ticket::postMessage` | §3.6 |
| M5 ✅ | impostazioni, reparti, topic, SLA, orari, agenti, team, ruoli | `OsticketConfig::updateSettings`, `Dept`, `Topic`, `SLA`, `Schedule`, `Staff`, `Team`, `Role` | §3.7 |
| M5 ✅ | email, template, ban list, filtri, form, liste, pagine, code, API key, log, plugin | `Email`, `EmailTemplateGroup`, `Filter`, `DynamicForm`, `DynamicList`, `Page`, `CustomQueue`, `API`, `Plugin` | §3.8 |

Restano al PHP: cron, fetch delle email, API REST, installer/upgrade, plugin (codice), OAuth2 e le modifiche ai form che richiedono DDL.

<!-- BEGIN contratti per area (generato da apps/web/docs/contract/*.md) -->
## 3. Contratti per area (TailTicket)

Sezione generata dai file `apps/web/docs/contract/*.md` con `npm run docs:contracts`: ogni area documenta le righe scritte e le differenze volute rispetto al PHP. Ogni operazione è coperta da scenari in `apps/web/test/diff/`.

### 3.1 infrastruttura, nota interna, risposta agente (M2.1–M2.2)

Fonte: `apps/web/docs/contract/core.md`.

Verificato con `test/diff/ticket-post.diff.test.ts`: 7 scenari, righe DB ed email identiche al PHP.

#### ThreadEntry::create (`src/server/domain/thread/write.ts`)

##### Riga `thread_entry`
| colonna | valore |
|---|---|
| `created`, `updated` | `NOW()` |
| `type` | `M`/`R`/`N` |
| `thread_id` | thread dell'oggetto |
| `pid` | ultimo messaggio `M` del thread (solo per le risposte), altrimenti 0 |
| `staff_id`, `user_id` | autore |
| `poster` | nome dell'agente nel formato `agent_name_format`, passato per `Format::sanitize` |
| `source` | `''` |
| `title` | `strip_emoticons(sanitize(title, striptags))`; `NULL` se vuoto |
| `format` | `html` (o `text` se `enable_richtext` è disattivo) |
| `ip_address` | IP dell'attore |
| `recipients` | JSON `MailingList::getEmailAddresses()`: `{"to":{"<user_id>":"Nome <email>"},"cc":{"<collab_id>":"…"}}` |

##### `flags`
Valore di partenza: 0. Si aggiungono:
- `0x40` BALANCED se `html`;
- `0x80` SYSTEM se non c'è autore;
- `0x20` COLLABORATOR se l'utente è collaboratore;
- `0x100` REPLY_ALL se i destinatari sono più di uno, altrimenti `0x200` REPLY_USER.

##### `body`
`editor_spacing` (`<p></p>` → `<p><br></p>`), poi `Format::sanitize` (htmLawed), `strip_emoticons`. Se il risultato è vuoto si salva `-`. Infine `stripExternalImages`.

##### `_search`
`REPLACE (H, id, title, content)` solo se l'autore è un agente o un utente. `content` = HTML con i tag trasformati in spazi, entità decodificate, spazi compressi.

#### postNote (Ticket::postNote)
1. Crea l'entry `N` come sopra.
2. Se è indicato `note_status_id`: `setStatus`.
3. `onActivity` ("New Internal Note"): avvisi `note.alert` se `note_alert_active` (vedi sotto).

#### postReply (Ticket::postReply)
1. Destinatari:
   - `all` = proprietario (to) + collaboratori attivi (cc, filtrati da `ccs`);
   - `user` = solo proprietario;
   - `none` = nessuna email.
2. Crea l'entry `R`. Poi `thread.lastresponse = NOW()`.
3. Cambio stato, se richiesto e diverso da quello attuale (`setStatus`).
4. Auto-claim: se `auto_claim_tickets`, il reparto non ha il flag `0x2` e il ticket è aperto senza assegnatario → `staff_id = agente`. Salvataggio con `updated = NOW()`.
5. `onResponse`: `isanswered = 1`. `updated = NOW()` solo se il valore cambia.
6. `onActivity` ("New Response").
7. Email `ticket.reply` dal reparto: email del reparto, altrimenti `default_email_id`; template del reparto, altrimenti `default_template_id`.
   - Variabili:
     - `%{recipient.*}` = proprietario;
     - `%{response}` = corpo HTML;
     - `%{signature}`: `none`/`mine`/`dept`, quest'ultima solo se il reparto è pubblico;
     - `%{company.name}`.
   - `%{recipient.ticket_link}` = `/view.php?auth=<token>` se non ci sono collaboratori, `/view.php?id=<id>` altrimenti. Se l'unico destinatario è il proprietario e ci sono collaboratori, si usa il token.

#### Ticket::save (`TicketRecord`)
- Si scrivono solo i campi cambiati (confronto debole PHP), con `updated = NOW()`.
- Poi si reindicizza `_search` (T): `title` = "numero oggetto", `content` = risposte indicizzabili del form, una per riga.

#### Ticket::setStatus (`status.ts`)
**Chiusura**
- Aggiorna:
  - `closed = lastupdate = NOW()`;
  - `staff_id` = agente che chiude;
  - `clearOverdue`;
  - `status_id`.
- Se `auto_refer_closed`: referral (S) al precedente assegnatario o all'agente.
- Evento `closed` con `{"status":[id,"Nome"]}`; gli eventi `closed` precedenti vengono annullati (`annul`).
- Bozze `ticket.%.<id>` eliminate (la LIKE "escapata" sugli allegati delle bozze non trova nulla: comportamento PHP replicato).

**Riapertura**
- Se il ticket è riapribile: auto-assegnazione all'assegnatario o al penultimo agente che ha risposto (`LIMIT 1,1`, come il PHP), se disponibile e con accesso al reparto. Altrimenti `staff_id = 0`.
- Aggiorna `closed = NULL`, `reopened = lastupdate = NOW()`.
- Evento `reopened` (annulla `closed`), poi `est_duedate` ricalcolata con lo SLA.

**Altri stati aperti**: evento `edited` `{"status":id}`. Se il ticket non era aperto: `isanswered = 0`.

#### Eventi (`events.ts`)
| colonna | valore |
|---|---|
| `thread_type` | `T` |
| `event_id` | da tabella `event` |
| `staff_id` | agente corrente se il ticket non è assegnato, altrimenti assegnatario |
| `team_id`, `dept_id`, `topic_id` | stato attuale del ticket |
| `data` | JSON PHP |
| `username` | username dell'agente, nome/email dell'utente, oppure `SYSTEM` |
| `uid`, `uid_type` | id e tipo (`S`/`U`) dell'attore |
| `timestamp` | `NOW()` |

#### Avvisi attività (onActivity, template `note.alert`)
Condizioni: `note_alert_active` e almeno un membro del reparto disponibile.

Destinatari:
- penultimo agente che ha risposto (`note_alert_laststaff`);
- assegnatario e membri del team con flag alert (`note_alert_assigned`);
- manager del reparto (`note_alert_dept_manager`).

Esclusi: agenti non disponibili, l'autore, i duplicati per email e, se il ticket è chiuso, gli agenti senza accesso.

Invio dall'email di alert (`alert_email_id`) con header `Auto-Submitted: auto-generated`.

#### Email (`src/server/mail/mailer.ts`)
- **Message-ID**: `B<sysid>-<rand5>-<base64(pack VVVa uid, entry, thread, classe) + HMAC-SHA1[-5:]>-<email di sistema>`.
- **HTML**: preceduto da `<div style="display:none" class="mid-<MID>">-- reply above this line --<br/><br/></div>`.
- **Testo**: alternativa con `Ref-Mid:`.
- **Header**:
  - `X-Mailer: osTicket Mailer`;
  - `Return-Path` = email di sistema (`-f` a sendmail);
  - `In-Reply-To`/`References` dall'ultimo messaggio arrivato via email;
  - immagini `cid:<chiave file>` incorporate inline con content-id `<chiave>@<dominio>`.
- **Trasporto**:
  - prima l'account SMTP attivo dell'email (password decifrata con `SECRET_SALT`, compatibile `Crypto`);
  - poi il MTA predefinito (`default_smtp_id`);
  - altrimenti `sendmail_path` (`OST_SENDMAIL_PATH`) con il messaggio su stdin, come `mail()` di PHP.
  - Errori in `syslog`: "Mailer Error".

#### Lock (`lock.ts`)
- Riga `lock`: `created = NOW()`, `staff_id`, `expire = NOW() + autolock_minutes`, `code` = 10 caratteri casuali.
- `ticket.lock_id` aggiornato, con `updated = NOW()` come `Ticket::save`. Il rilascio elimina la riga e azzera `lock_id`.
- Modalità `ticket_lock`: 1 alla visualizzazione, 2 all'attività (default).

### 3.2 azioni sul ticket di un agente (M2.3 parte A)

Fonte: `apps/web/docs/contract/actions.md`.

Verificato con `test/diff/ticket-actions.diff.test.ts`: **47 scenari**, righe DB ed email identiche al PHP
(operazioni PHP in `test/diff/php/ops/actions.php`, che ripercorrono `include/ajax.tickets.php`).

```
OST_DIFF_TAG=actions MAILPIT_SMTP_PORT=1026 MAILPIT_HTTP_PORT=8026 \
  npx vitest run -c vitest.diff.config.mts test/diff/ticket-actions.diff.test.ts
```

#### File
| Livello | File | Contenuto |
|---|---|---|
| Dominio | `src/server/domain/ticket/assign.ts` | assegnazione, presa in carico, rilascio, referral, rimozione referral, scelte dei form |
| Dominio | `src/server/domain/ticket/transfer.ts` | trasferimento di reparto |
| Dominio | `src/server/domain/ticket/ticket-state.ts` | cambio stato da menu, riapertura, segna risposto, stati del menu, avviso `isCloseable`, aggancio "deleted" |
| Dominio | `src/server/domain/ticket/alerts.ts` | destinatari e invio degli avvisi agli agenti |
| Server action | `src/app/[locale]/(staff)/agent/(panel)/tickets/[id]/actions-assign.ts` | `assignAction`, `claimAction`, `releaseAction`, `transferAction`, `referAction`, `removeReferralsAction`, `statusAction`, `markAction` |
| UI | `src/components/tickets/TicketActionsMenu.tsx` (server) + `src/components/tickets/actions/*` (client) | barra azioni della vista ticket e modali |
| Testi | `src/messages/actions/{it,en}.json` | namespace `ticketActions` |

#### Convenzioni comuni
- Ogni `Ticket::save` passa da `TicketRecord`: solo i campi cambiati, `updated = NOW()` e reindicizzazione `_search` (T).
- Gli eventi passano da `logTicketEvent`:
  - `thread_event.staff_id` = assegnatario dopo la modifica, oppure l'agente se il ticket non è assegnato;
  - `team_id` e `dept_id` sono quelli del ticket;
  - `uid` = agente, `uid_type = 'S'`, `username` = username dell'agente, `timestamp = NOW()`.
- I commenti dei form sono HTML passato per `Format::sanitize` (TextareaField html). "Vuoto" = solo tag, `&nbsp;` e spazi.
  - Eccezione: `setTicketStatus` riceve `$_REQUEST['comments']` grezzo, che viene pulito da `ThreadEntryBody`.
- Le note con commento sono `thread_entry` di tipo `N` create con `postNote`:
  - autore l'agente, `poster` = nome dell'agente, formato html, indice `_search` H;
  - `thread.lastresponse` e `ticket.lastupdate` non cambiano (sono note).
- Gli avvisi email partono **dopo il commit** (`ctx.after`), con:
  - l'email del reparto (`department.email_id`, altrimenti `default_email_id`) e il gruppo di template del reparto;
  - la doppia sostituzione delle variabili del PHP (evento, poi `%{recipient}`);
  - destinatari non disponibili (inattivi o in ferie) o con email già usata saltati;
  - header di avviso (`Auto-Submitted`) e Message-ID legato alla nota, se presente.
- Tutte le operazioni ricontrollano sessione e `checkStaffPerm`. Ticket inaccessibile → `not_found`; permesso mancante → `denied`.

#### Assegnazione (`assignTicket`) — ajax `assign` + `AssignmentForm` + `Ticket::assign`
Permessi: `ticket.assign` sul ticket.

Validazione del form:
- `s<id>`: agente tra quelli di `Dept::getAssignees`:
  - attivi e non in ferie;
  - solo membri/primari con i flag `0x1`/`0x10`;
  - limitati da `applyDeptVisibility` se l'assegnatore non ha `visibility.agents`.
- `t<id>`: team tra quelli di `Team::getActiveTeams` (abilitati, con membri disponibili). Il team deve essere abilitato e avere membri.

Ordine delle scritture:
1. **Agente**:
   - errore se già assegnato, non disponibile, o se `Dept::canAssign` fallisce;
   - altrimenti `DELETE thread_referral` del referral `S` del nuovo assegnatario.

   **Team**: errore se già assegnato; altrimenti cancellazione del referral `E` del team.
2. `ticket.staff_id` (o `team_id`) + `updated` (save).
3. `thread_event` **assigned**, con dati:
   - `{"staff":[id,"Nome Cognome"]}` (nome originale `first last`);
   - `{"claim":true}` se l'agente assegna sé stesso (nessun avviso);
   - `{"team":id}`.
4. `onAssign`:
   - se il ticket è chiuso, `Ticket::reopen` (vedi "Riapertura");
   - nota con i commenti, titolo `Ticket Assigned to <nome>` o `Ticket claimed by <agente>`, senza avvisi.
5. Avviso `assigned.alert`, se `assigned_alert_active` e il reparto ha membri per gli avvisi (`Dept::getMembersForAlerts`):
   - agente: a lui, se `assigned_alert_staff`;
   - team senza flag NOALERTS `0x2`: ai membri con flag avvisi se `assigned_alert_team_members`, altrimenti al capo team se `assigned_alert_team_lead`;
   - variabili `%{assignee}`, `%{assigner}`, `%{comments}` (HTML dei commenti), poi `%{recipient}`.
6. Se richiesto `refer`: `INSERT thread_referral` (`created = NOW()`) al precedente agente (`S`) o team (`E`), se non già presente.

#### Presa in carico (`claimTicket`) — ajax `claim` + `Ticket::claim` + `assignToStaff`
Permessi e condizioni:
- `ticket.assign`;
- ticket aperto e nessun agente assegnato (un team sì);
- agente disponibile e `Dept::canAssign`.

Scritture, in ordine:
1. `staff_id` (save);
2. `onAssign` senza avvisi (nota `Ticket claimed by …` se ci sono commenti);
3. evento **assigned** `{"claim":true}`;
4. cancellazione del referral `S` dell'agente.

`assignToStaff`/`assignToTeam` sono esportati anche per usi di sistema:
- dati evento `{"staff":id}` / `{"team":id}`;
- `assignToTeam` azzera `staff_id` sui ticket chiusi (secondo save).

#### Rilascio (`releaseTicket`) — ajax `release` + `Ticket::release`
Permessi: `ticket.release` oppure manager del reparto del ticket (vedi differenze). Solo ticket assegnati, con almeno una casella scelta.
- **Agente e team** (`unassign`): due salvataggi separati, prima `staff_id = 0` e poi `team_id = 0`.
- **Solo agente** / **solo team**: un solo salvataggio.
- Evento **released** con `{"staff":[id,"Nome Cognome"]}` e/o `{"team":id}` per ciò che è stato rilasciato.
- Nota `Assignment Released` con i commenti (senza avvisi).

#### Trasferimento (`transferTicket`) — ajax `transfer` + `TransferForm` + `Ticket::transfer`
Permessi: `ticket.transfer`. Il reparto deve essere:
- tra quelli proposti da `DepartmentField` con `hideDisabled`: attivi; senza `visibility.departments`, solo quelli accessibili;
- diverso dall'attuale.

Scritture, in ordine:
1. `dept_id`; `staff_id = 0` se il ticket è assegnato, il nuovo reparto ha `ASSIGN_MEMBERS_ONLY` e l'agente non ne è membro; save.
2. Se il ticket è chiuso: `Ticket::reopen` (vedi "Riapertura").
3. SLA: se il ticket non ha SLA, o il suo è *transient* (`0x8`), e il nuovo reparto ne ha uno → `sla_id` (save).
   `est_duedate` **non** viene ricalcolata (comportamento PHP).
4. Evento **transferred** `{"dept":"<nome reparto>"}`; cancellazione del referral `D` al nuovo reparto.
5. Nota `Ticket transferred from <vecchio> to <nuovo>` con i commenti (senza avvisi).
6. Se `refer`: referral `D` al reparto precedente.
7. Avviso `transfer.alert`, se `transfer_alert_active` e il nuovo reparto ha membri per gli avvisi. Destinatari:
   - l'assegnatario (agente, oppure membri del team con flag avvisi), se `transfer_alert_assigned` e il ticket è assegnato;
   - altrimenti i membri del reparto (`transfer_alert_dept_members`);
   - in più il manager (`transfer_alert_dept_manager`).

   Variabili: `%{comments}` è la nota (vuota se assente), `%{staff}` è l'agente.

#### Referral (`referTicket`) — ajax `refer` (`do=refer`) + `ReferralForm` + `Ticket::refer`
Permessi: `ticket.assign` e `ticket.refer` (vedi differenze).

Scelte disponibili:
- agenti attivi di altri reparti (`Staff::nsort`);
- team attivi;
- reparti attivi visibili.

Errori:
- agente già assegnatario o non disponibile;
- team già assegnato;
- ticket già nel reparto;
- referral già presente (`refer_failed`).

Scritture, in ordine:
1. `thread_referral` (`S`/`E`/`D`, `created = NOW()`);
2. evento **referred** `{"staff":[id,"Nome"]}` / `{"team":id}` / `{"dept":id}`;
3. nota `Referral` con i commenti, **con** avvisi `note.alert` (`logNote`: `note_alert_*`).

#### Rimozione dei referral (`removeReferrals`) — ajax `refer` (`do=manage`)
Permessi: come il referral.

Scrittura: `$thread->referrals->filter(['id__in' => $remove])->delete()`, cioè una sola
`DELETE FROM thread_referral WHERE thread_id = <thread del ticket> AND id IN (...)`.
- Gli id di altri thread vengono ignorati.
- Nessun evento, nessuna nota (nel PHP c'è un `TODO: log removal`), il ticket non viene toccato.
- Restituisce il numero di righe rimosse (`removed`), mostrato come "Rimossi N referral".

#### Cambio stato da menu (`changeTicketStatus`) — ajax `setTicketStatus`
Permessi per stato di destinazione:

| Stato | Permesso richiesto |
|---|---|
| *open* | `ticket.close` o `ticket.create` |
| *closed* | `ticket.close` |
| *deleted* | `ticket.delete`, più l'aggancio `hardDelete` (vedi sotto) |

Errori: stato sconosciuto (`invalid_status`), stato già attuale (`already_status`).

Poi `setTicketStatus` (`status.ts`, `Ticket::setStatus`) con i commenti:
- **Chiusura**:
  - `Ticket::isCloseable` (campi obbligatori, task aperti, help topic obbligatorio);
  - se il ticket non è chiudibile: errore `not_closeable` con il testo PHP in `detail`, nessuna scrittura;
  - `closed`, `lastupdate` e `staff_id` = agente che chiude; overdue azzerato;
  - referral all'agente (precedente assegnatario o chi chiude) se `auto_refer_closed`;
  - evento **closed** `{"status":[id,"nome"]}` (annulla i precedenti);
  - cancellazione delle bozze `ticket.%.<id>`.
- **Riapertura**: vedi sotto.
- **Cambio tra stati con lo stesso state**: evento **edited** `{"status":id}`.
- **Commenti**: nota `Status Changed` **con** avvisi `note.alert`.
- **Ticket figli** (`children`): solo se il ticket ha `FLAG_PARENT 0x10`. Ai figli (`ticket_pid`, ordinati per `sort`) va lo stesso stato senza commento. I numeri dei figli non aggiornati sono restituiti in `warn`.

##### Riapertura (`Ticket::reopen` / ramo *open* di `Ticket::setStatus`)
- Si applica se il ticket è chiuso e `isReopenable`: stato con `allowreopen` + `reopenstatus`, reparto e help topic non archiviati (`Topic::FLAG_ARCHIVED = 0x4`).
- Riassegnazione all'agente di chiusura, o al penultimo che ha risposto (`getLastRespondent`), se:
  - è disponibile;
  - ha accesso al reparto (`Staff::canAccessDept`);
  - il reparto non ha `DISABLE_REOPEN_AUTO_ASSIGN`.

  Altrimenti `staff_id = 0` (save separato).
- `closed = NULL`, `lastupdate = reopened = NOW()`, `isanswered = 0`, nuovo `status_id`.
- Evento **reopened** (annulla i **closed**); `est_duedate` ricalcolata con lo SLA attuale.
- `Ticket::reopen` (da assegnazione o trasferimento) usa lo stato di riapertura dello stato attuale se di tipo *open*, altrimenti `default_ticket_status_id`.

##### Aggancio "deleted" (area ticketedit)
`changeTicketStatus(ctx, input, { hardDelete })` accetta un `TicketHardDelete = (ctx, rec, comments) => Promise<boolean>`
(= `Ticket::delete($comments)`), passato a `setTicketStatus` per il ticket e per ogni figlio (commento vuoto).
- Senza aggancio la richiesta è rifiutata con `not_supported`, senza scritture.
- Il punto da collegare è `statusAction` in `actions-assign.ts` (commento `AGGANCIO "ticketedit"`).
- La voce "Elimina ticket" (`PERM_DELETE`, menu "Altro" del PHP) è dello slot `TicketExtraActions`.

#### Segna risposto / non risposto (`markTicketAnswered`) — ajax `markAs`
Permessi: `ticket.markanswered` oppure manager del reparto del ticket. Errore se il ticket è già nello stato richiesto.

Scritture, in ordine:
1. `isanswered` (save);
2. nota con i commenti, titolo `Ticket Marked Answered|Unanswered`, senza avvisi;
3. nota di sistema `logActivity`:
   - stesso titolo, corpo `Ticket flagged as answered by <agente>`;
   - `staff_id = 0`, `poster = SYSTEM`, flag `SYSTEM|BALANCED`;
   - nessuna riga `_search` H.

Non viene registrato nessun `thread_event`.

#### UI (vista ticket)
Voci come `include/staff/ticket-view.inc.php` e `templates/status-options.tmpl.php`:

| Voce | Condizione |
|---|---|
| **Assegna/Riassegna** | ticket aperto + `ticket.assign` |
| ↳ Prendi in carico | nessun agente assegnato e (reparto non "solo membri" o agente membro) |
| ↳ Ad un agente / Ad un team | sempre, nel menu Assegna |
| **Trasferisci** | `ticket.transfer` (anche su ticket chiusi) |
| **Cambia stato** | `ticket.close`; stati *open* e *closed* abilitati, nell'ordine della lista (`list.sort_mode`), escluso l'attuale |
| **Altro → Rilascia** | ticket assegnato (e aperto) + (`ticket.release` o manager del reparto) |
| **Altro → Segna come (non) risposto** | ticket aperto + (`ticket.markanswered` o manager del reparto) |
| **Altro → Gestisci referral** | `ticket.refer` + `ticket.assign` |

Modali come i template PHP:
- **Assegnazione**: preselezione dell'assegnatario attuale. La casella "mantieni referral" compare solo se esiste un assegnatario del tipo scelto.
- **Presa in carico**: con un team già assegnato mostra l'assegnazione attuale, altrimenti chiede conferma.
- **Rilascio**: con agente e team si sceglie cosa rilasciare (nessuna casella preselezionata), altrimenti si conferma.
- **Referral**: elenco dei referral con rimozione, e form di referral.
- **Cambio stato**:
  - select di tutti gli stati con lo stesso *state*, attuale compreso;
  - avviso `isCloseable()` nel modale di chiusura;
  - casella "anche ai figli" se il ticket è padre.

Dopo l'azione:
- assegnazione, trasferimento e chiusura tornano alla lista `/agent/tickets` (`data-redirect="tickets.php"`);
- presa in carico, rilascio, segna risposto, referral e riapertura ricaricano la vista e mostrano l'esito;
- le server action invalidano la cache del router (`revalidatePath("/", "layout")`);
- gli errori sono tradotti (`ticketActions.errors.<codice>`).

#### Differenze volute rispetto al PHP
- **Rilascio**: il PHP accetta, oltre a `ticket.release`, il manager del reparto *primario* dell'agente
  (`Staff::isManager()` senza argomenti). Si applica la regola più stretta: manager del reparto del ticket
  (la stessa che mostra la voce nella vista).
- **Rilascio di un ticket non assegnato**: il PHP imposta l'errore ma esegue comunque il rilascio. Per esempio azzera
  l'agente di chiusura di un ticket chiuso e registra un evento vuoto. Qui l'operazione è rifiutata (`not_assigned`);
  la UI del PHP non la propone.
- **Referral e rimozione dei referral**: il PHP mostra la voce con `ticket.refer` ma l'endpoint controlla solo
  `ticket.assign`. Qui si richiedono entrambi.
- **Figli non aggiornati nel cambio stato**: il PHP prepara `$info['warn']` ma risponde comunque 201, e l'avviso va perso.
  Qui i numeri dei figli vengono mostrati in un avviso.
- **Messaggi dopo il redirect alla lista**: il PHP li mostra tramite `$_SESSION['::sysmsgs']`. Next non ha messaggi
  flash: l'esito compare solo per le azioni che restano sulla vista.

- **Solo stati sceglibili** (`isSelectableStatus` in `ticket/status.ts`): il PHP lato server accetta qualsiasi
  `status_id` (`TicketStatus::lookup`) nel menu "Cambia stato", nella risposta (`reply_status_id`), nella nota
  (`note_status_id`), nell'azione di massa e nel nuovo ticket dell'agente. Con una richiesta costruita a mano un agente
  poteva impostare uno stato che l'amministratore ha disabilitato. Qui valgono solo gli stati delle select del PHP
  (abilitati, *open* o *closed*; lo stato *deleted* resta per l'eliminazione): il menu e la massa rispondono
  `invalid_status`, risposta e nota vengono salvate senza cambiare stato, il nuovo ticket usa lo stato dell'argomento
  o quello predefinito. Test: `ticket-actions` e `ticket-post` ("stato disabilitato").
- **Chiusura con un campo obbligatorio disabilitato**: in `Ticket::getMissingRequiredFields` l'array di criteri
  `flags__hasbit` sovrascrive `FLAG_ENABLED`, quindi un campo "obbligatorio in chiusura" ma disabilitato (che l'agente
  non vede e non può compilare) impediva per sempre la chiusura. Qui contano solo i campi abilitati. È un difetto
  funzionale, non di permessi; il ticket chiuso ha le stesse righe di una chiusura normale. Test: `ticket-actions`
  ("campo obbligatorio disabilitato").

#### Stranezze PHP replicate (annotate nel codice)
- `est_duedate` non ricalcolata quando il trasferimento cambia lo SLA.
- Due salvataggi separati (e due `updated`) nel rilascio di agente e team.
- Evento **assigned** con il nome *originale* `first last` anche se il formato dei nomi è diverso.
- `Ticket::getLastRespondent` usa la *penultima* risposta di un agente (`LIMIT 1,1`).
- `deleteDrafts` usa una LIKE in cui il `%` del namespace è escapato.
- `markAs`: in caso di errore di `markUnAnswered()` il PHP scrive `$errors['err'] - __(...)` (sottrazione invece di
  assegnazione), quindi l'errore non viene impostato. Il caso non è raggiungibile con un ticket valido.

### 3.3 modifica del ticket (M2.3 parte B, area "ticketedit")

Fonte: `apps/web/docs/contract/ticketedit.md`.

Verificato con 60 scenari differenziali (righe DB ed email identiche al PHP, operazioni PHP in
`test/diff/php/ops/ticketedit.php`):

```
OST_DIFF_TAG=ticketedit MAILPIT_SMTP_PORT=1027 MAILPIT_HTTP_PORT=8027 \
  npx vitest run -c vitest.diff.config.mts test/diff/ticket-edit*.diff.test.ts
```

| File di test | Scenari |
|---|---|
| `ticket-edit.diff.test.ts` | Ticket::update, Ticket::updateField, Ticket::changeOwner (13) |
| `ticket-edit-delete.diff.test.ts` | eliminazione da stato "deleted" e Ticket::delete (6) |
| `ticket-edit-collab.diff.test.ts` | collaboratori, segna scaduto, ban list (13) |
| `ticket-edit-merge.diff.test.ts` | link, scollegamento, merge combinato/separato (8) |
| `ticket-edit-mass.diff.test.ts` | azioni di massa (11) |
| `ticket-edit-entry.diff.test.ts` | modifica delle voci del thread (5) |
| `ticket-edit-export.diff.test.ts` | export CSV delle code (4, sola lettura: CSV confrontato) |

#### File
| Livello | File | Contenuto |
|---|---|---|
| Dominio | `src/server/domain/ticket/edit.ts` | `updateTicket`, `updateTicketField`, `changeTicketOwner`, `selectSlaId`, helper `phpAssocJson`, `userDateToDb` |
| Dominio | `src/server/domain/ticket/delete.ts` | `deleteTicket` (Ticket::delete), `deleteThread`, `deleteOrphanFiles`, `ticketHardDelete` (aggancio di `changeTicketStatus`) |
| Dominio | `src/server/domain/ticket/merge-flags.ts` | flag di merge, `setMergeType`, `setPid`, `ticketThread` (thread T o C), `childTickets` |
| Dominio | `src/server/domain/ticket/merge.ts` | `mergeTickets` (manageMerge + merge), `unlinkTicket(s)`, `relatedTickets` |
| Dominio | `src/server/domain/ticket/collaborators.ts` | `addTicketCollaborator`, `addCollaborator`, `updateCollaborators` |
| Dominio | `src/server/domain/ticket/overdue.ts` | `markTicketOverdue` (+ avvisi `ticket.overdue`), `setTicketEmailBan`, `emailInBanList` |
| Dominio | `src/server/domain/ticket/mass.ts` | `massAssign`, `massClaim`, `massTransfer`, `massDelete`, `massChangeStatus`, `massMergeCandidates`, `massAssignableAgents` |
| Dominio | `src/server/domain/ticket/export.ts` | `exportQueueCsv`, `queueExportFields`, `exportableFields`, `csvLine` |
| Dominio | `src/server/domain/thread/edit.ts` | `editThreadEntry`, `canEditEntry`, `entryEditContext` |
| Dominio (additivo) | `src/server/domain/queue/engine.ts` | `exportQueueTicketIds` |
| Server action | `tickets/[id]/actions-edit.ts`, `tickets/actions-mass.ts` | azioni della vista ticket e della lista |
| Route | `src/app/api/agent/tickets/export/route.ts` | download del CSV |
| UI | `src/components/tickets/TicketExtraActions.tsx` + `edit/*`; `src/components/tickets/mass/*` | menu "Modifica"/"Gestisci" e dialoghi; barra di massa ed export nella lista |
| Testi | `src/messages/ticketedit/{it,en}.json` | namespace `ticketEdit` |

#### Convenzioni comuni
- `Ticket::save` passa da `TicketRecord`: solo i campi cambiati (confronto debole), `updated = NOW()`, `_search` T.
- Eventi con `logTicketEvent`/`logThreadEvent` (staff_id = assegnatario o agente se non assegnato). Dove il PHP
  produce JSON con chiavi in un ordine particolare (array misti) i dati sono serializzati con `phpAssocJson`.
- Tutte le operazioni ricontrollano sessione e permessi; ticket inaccessibile → `not_found`, permesso mancante → `denied`.

#### Ticket::update (form "Modifica", scp/tickets.php a=update) — `updateTicket`
Permesso `ticket.edit`. Validazione come `Validator::process` + controlli del PHP:
- `topicId` numerico obbligatorio (anche `0`), topic esistente ma non attivo → `inactive`;
- `slaId`, `user_id` numerici se presenti; `source` tra Phone/Email/Web/API/Other;
- scadenza: non su ticket chiusi, interpretabile, nel futuro;
- form dinamici: campi memorizzabili, visibili e modificabili dall'agente (obbligatori per l'agente, validatori).
Con errori nessuna scrittura (`{error:"invalid", fields}`).

Scritture, in ordine:
1. Risposte mancanti dei campi aggiunti al form (`form_entry_values` con `value = NULL`; il PHP lo fa all'apertura della
   pagina di modifica con `addMissingFields`).
2. `ticket.topic_id`, `sla_id`, `source`, `duedate` (data come la scrive il PHP: stringa interpretata **in UTC**,
   convertita nel fuso del DB — stranezza replicata), `user_id` (se indicato), `isoverdue = 0` se c'è una scadenza; save.
3. Nota `Ticket Updated` (se c'è) con **avvisi** `note.alert` (logNote).
4. Risposte dei form cambiate: `UPDATE form_entry_values` (value / value_id) + upsert della colonna in `ticket__cdata`;
   `form_entry.sort` se l'ordine cambia; form rimossi → DELETE di entry e risposte.
5. Evento **edited** con le modifiche nell'ordine di assegnazione:
   `{"topic_id":[vecchio,nuovo],"sla_id":[...],"source":[...],"duedate":[...],"user_id":[...],"fields":{"<id>":[vecchio,nuovo]}}`;
   i valori nuovi sono quelli inviati (stringhe), le priorità `["Label",id]`. Nessun evento senza modifiche.
6. Se lo SLA non è stato cambiato e manca o è transitorio (`0x8`): `selectSLAId` (reparto → topic → `default_sla_id`).
7. `updateEstDueDate` (est_duedate ricalcolata), reindicizzazione `_search`.

#### Ticket::updateField (ajax editField) — `updateTicketField`
Permesso `ticket.edit`. Valore uguale all'attuale → `already_set` senza scritture.
- **Campi dei form** (`priority` o id del campo): `form_entry_values` + `ticket__cdata`, save del ticket; evento **edited**
  `{"0":vecchio,"1":nuovo,"fields":{"<id>":[vecchio,nuovo]}}` (memo: tag rimossi e troncati a 200 caratteri).
- **topic** (`topic_id`, topic attivo o attuale), **sla** (`sla_id`; un id non valido non cambia nulla ma registra
  l'evento con dati NULL, come il PHP), **source**, **duedate**: colonna + save; evento `{"<colonna>":[vecchio,nuovo]}`.
- Nota `<etichetta> updated` con i commenti, **senza** avvisi.
- `lastupdate = NOW()`; per SLA e scadenza `updateEstDueDate`; save; `_search`.

#### Ticket::changeOwner (do=changeuser) — `changeTicketOwner`
`ticket.user_id` (save), cancellazione dell'eventuale collaboratore con quell'utente, evento **edited**
`{"owner":<id>,"fields":{"Ticket Owner":"<nome>"}}`.

#### Collaboratori — `addCollaborator`, `updateCollaborators`
- Aggiunta (ajax add-collaborator / do=addcc): il proprietario non può essere collaboratore (`owner`); già presente →
  `already_collaborator`. `INSERT thread_collaborator` (flags `ACTIVE|CC` = 3, role `M`, created/updated NOW);
  evento **collab** `{"add":{"<user_id>":{"name":"<nome>"}}}`.
- Aggiornamento (ajax collaborators): per ogni `del` DELETE + evento **collab** `{"del":{...}}`; `cid` → `updated = NOW()`
  e flag ACTIVE; tutti gli altri collaboratori del thread perdono ACTIVE e ricevono comunque `updated = NOW()`.

#### Merge e link — `mergeTickets`, `unlinkTickets`
Permesso `ticket.merge` (merge) o `ticket.link` (link) su **tutti** i ticket, verificato prima di scrivere.
- **manageMerge** (per ogni ticket nell'ordine, il primo è il padre): scioglie i link se si passa a merge o si cambia
  il padre di un link; `sort = posizione` (ticket "visual"); se va collegato: eventi **merged|linked**
  `{"ticket":"Ticket #<num>","id":<id>}` su padre e figlio, `ticket_pid`, flag del padre `PARENT|tipo` e del figlio `tipo`
  (`0x1` combine, `0x2` separate, `0x8` link); per i merge con reparti diversi referral `D` sul thread del padre +
  evento **referred** `{"dept":<id>}`.
- **merge** (solo combine/separate): per ogni figlio collaboratori (partecipanti "all") e proprietario aggiunti al padre
  (evento collab del proprietario con chiave vuota `{"add":{"":{"name":...}}}`: stranezza replicata); voci del thread
  del figlio spostate nel thread del padre (`flags |= 0x400`, riga `thread_entry_merge {"thread":<thread figlio>}`,
  `_search` H); thread del figlio `object_type = 'C'`, `extra = {"ticket_id":<padre>,"number":"<num figlio>"}`;
  stato di chiusura forzata del figlio (setStatus, referral all'assegnatario se `auto_refer_closed`); stato del padre;
  task del figlio spostati (`task.object_id`, senza filtro sul tipo, come il PHP); eliminazione del figlio.
- **unlink**: figlio → `ticket_pid NULL`, `sort 1`, senza LINKED, eventi **unlinked** su figlio e padre; un padre
  scollega tutti i figli e perde `PARENT|LINKED` (un figlio scollegato da solo lascia il padre "padre").
- Il PHP risponde 404 ai link riusciti: qui l'esito è positivo.

#### Eliminazione — `deleteTicket` / `ticketHardDelete`
Collegata a `changeTicketStatus` (stato "deleted", permesso `ticket.delete`) con `{ hardDelete: ticketHardDelete({children}) }`.
Ordine: DELETE ticket + `_search` T; figli di un padre → `ticket_pid NULL`, flag di merge azzerati (save), thread `T`;
per un figlio il padre senza altri figli torna normale e il thread **non** viene eliminato; altrimenti DELETE thread,
`_search` H delle voci, `thread_entry_email.headers = NULL`, allegati H (+ `AttachmentFile::deleteOrphans`: file `T`
senza allegati creati da più di un giorno, con i `file_chunk`), collaboratori, referral, voci, `thread_event.thread_id = 0`;
evento **deleted** sul vecchio thread; DELETE form_entry + risposte; bozze `ticket.%.<id>`; riga `ticket__cdata`;
syslog Debug "Ticket #N deleted" (`<hr>` + commenti, solo con `log_level` 3). Il lock del ticket resta (come il PHP).
Con "anche ai figli" i figli vengono eliminati dopo il padre (controllo `ticket.delete` per figlio).

#### Segna scaduto e ban list — `markTicketOverdue`, `setTicketEmailBan`
- Scaduto (solo manager del reparto, ticket aperto): `isoverdue = 1` (save), evento **overdue**, avvisi
  `ticket.overdue` (SLA senza NOALERTS, `overdue_alert_active`; assegnatario/membri del team se
  `overdue_alert_assigned`, altrimenti membri del reparto se non assegnato e `overdue_alert_dept_members`; più il
  manager), poi nota di sistema `Ticket Marked Overdue` / `Ticket flagged as overdue by <agente>` (SYSTEM, senza avvisi).
  Se già scaduto solo la nota.
- Ban (`emails.banlist`): `INSERT filter_rule` (filtro "SYSTEM BAN LIST", `email equal <indirizzo>`, isactive 1,
  notes '', created/updated NOW); unban: DELETE delle regole corrispondenti.

#### Azioni di massa — `mass.ts`
Riusano `assignTicket`, `assignToStaff`, `transferTicket`, `setTicketStatus`, `deleteTicket`, `mergeTickets`.
- Assegna (agenti di `Staff::getDeptAgents` filtrati per reparti "solo membri"), presa in carico (Ticket::claim non
  controlla stato e assegnatario: un ticket già assegnato passa all'agente), trasferisci, elimina (ticket.delete in
  almeno un ruolo), cambio stato (`canManageTickets` + permesso per stato in almeno un ruolo; nota "Status Changed"
  con avvisi; "deleted" elimina), merge/link.
- Stranezza replicata: per trasferimento e cambio stato il PHP condivide `$errors` tra i ticket; dopo il primo errore
  di validazione (già nel reparto, non chiudibile) i ticket successivi falliscono senza scritture.

#### Modifica di una voce del thread — `editThreadEntry`
Visibile per voci non di sistema (risposte solo di agenti); permesso: voce propria, manager del reparto o
`thread.edit`. Corpo pulito identico → nessuna scrittura. Altrimenti nuova `thread_entry` (pid = voce, stessi
autore/poster/tipo, titolo `htmlchars`, `recipients` **NULL** come il PHP), allegati non inline spostati,
`flags = (base & ~HIDDEN & ~GUARDED) | EDITED`, `editor`/`editor_type 'S'`, `created` della base, `updated NOW`;
la base riceve `HIDDEN`. Una seconda modifica dello stesso agente sostituisce la precedente (DELETE + `_search`).

#### Export CSV — `exportQueueCsv`
Campi della coda (`queue_export`, ereditati con `0x80`, oppure gli standard + campi cdata), eventuale selezione;
ticket della coda con visibilità e ordinamento della lista **senza** filtro sui figli dei merge; BOM UTF-8,
`fputcsv` (virgolette solo se il campo contiene separatore, virgolette, spazi o a capo); valori come
`from_query ?: valore grezzo ?: ''` (contatori a 0 vuoti, Yes/No, nomi completi di reparto e topic).
Il PHP prepara il file in background e lo invia per email se non scaricato: qui il download è immediato.

#### Differenze volute (permessi) rispetto al PHP
- **Cambio stato di massa**: solo stati abilitati *open*/*closed* (o *deleted*), come nel menu: vedi area "actions", "Solo stati sceglibili".
- Collaboratori: gli endpoint ajax controllano solo l'accesso al ticket; qui serve `ticket.reply` o `ticket.edit`
  (come la vista). La riattivazione `cid` è limitata ai collaboratori del thread.
- Merge/link: niente scorciatoia "thread con un referral qualsiasi" (`isReferred()`), permessi verificati su tutti i
  ticket prima di scrivere; scollegamento (`dtids`) con `ticket.link` o `ticket.merge` (il PHP non controlla nulla).
- Merge con thread "nipoti" ancora pieni: il PHP chiamerebbe `saveExtra` con argomenti scambiati (errore); qui le
  voci vengono spostate normalmente.

#### Altre differenze
- `addMissingFields` avviene al salvataggio invece che all'apertura del form (stesso risultato finale).
- Ban list mancante: il PHP crea il filtro "SYSTEM BAN LIST"; qui l'operazione risponde `no_banlist`.
- Testi "Yes/No" e intestazioni del CSV in inglese come il PHP con lingua di sistema `en_US`.

### 3.4 area "create" (M3 A: creazione ticket e allegati)

Fonte: `apps/web/docs/contract/create.md`.

Riferimenti PHP: `include/class.ticket.php` (Ticket::create, Ticket::open, filterTicketData, onNewTicket,
onOpenLimit, postCannedReply, assign/assignToStaff/assignToTeam), `class.filter.php`, `class.filter_action.php`,
`class.dynamic_forms.php`, `class.forms.php`, `class.file.php`, `class.user.php`, `class.list.php`,
`scp/tickets.php` (a=open), `open.php`.
Diff test: `test/diff/ticket-create.diff.test.ts` (43 scenari) con le op di `test/diff/php/ops/create.php`.

#### API

```ts
// src/server/domain/ticket/create.ts — da eseguire dentro runWrite()
createTicket(ctx: WriteContext, input: CreateTicketVars, origin: "staff" | "web",
             opts?: { autorespond?: boolean; alertstaff?: boolean }): Promise<CreateResult>
openTicket(ctx: WriteContext, input: OpenTicketInput, opts?: CreateOptions): Promise<CreateResult>   // agente

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

Altre API: `uploadFile`, `createAttachmentFile`, `attachFilesToEntry`, `signUploadToken`, `verifyUploadTokens`,
`threadUploadRules` (`file/upload.ts`); `postCannedReply` (`ticket/create-canned.ts`); `sendFilterEmail`,
`onOpenLimit`, `onNewTicket`, `onAssignAlert`, `sendNewTicketNotice` (`ticket/create-alerts.ts`);
`formView`, `baseForms`, `topicFormsView`, `openTicketOptions`, `searchUsers`, `usersByIds`, `formDataToVars`
(`ticket/create-ui.ts`); `FormInstance`, `saveFormEntry`, `ensureListPropertiesForm` (`forms/entry.ts`);
`phpParseDateTime`, `phpTzAbbr`, `phpFormatDate` (`forms/fields.ts`); `prepareSupportedMatches`
(`filter/ticket-filter.ts`); `adminAlertMail`, `logWithAdminAlert` (`system/admin-alert.ts`).

#### Ordine delle scritture (Ticket::create)

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

#### Email (verificate via Mailpit)
`ticket.alert`, `ticket.autoresp`, `ticket.notice`, `ticket.reply`, `ticket.autoreply` (canned), `assigned.alert`,
`ticket.overlimit`, avvisi admin solo testo ("Maximum Open Tickets Limit", "Overlimit Notice"), email dei filtri.

#### Differenze rispetto al PHP
- **Sicurezza (non replicato)**: dal portale si accettano solo i campi visibili ai clienti (il PHP salva anche i campi
  solo-agenti inviati in POST); in `Ticket::open` un reparto senza accesso (ruolo "solo creazione", `__new__`) non
  consente l'assegnazione; gli allegati richiedono un token firmato del proprietario (al posto di `$_SESSION[':uploadedFiles']`).
- `file.key` è casuale come nel PHP (prefisso da microtime): i test lo ignorano.
- FA_SendEmail: il PHP passa `"Nome" <email>` come stringa e il nome arriva codificato con le virgolette; qui senza.
- Canned response con immagini `cid:`: `Format::viewableImages` non replicato.
- Estensione del telefono: il PHP la legge solo con il nome "hash" del campo; Next la legge da `<nome>-ext`.
- Formato delle date nei template (`%{ticket.create_date}`): `mail/objects.ts` FormattedDate usa `datetime_format` anche
  quando `date_formats` non è `custom` (il PHP usa il formato breve ICU, es. "10/9/26 2:36 PM"): da correggere nel core.

#### Stranezze PHP replicate
- Scadenza e date dei campi interpretate in UTC (default di bootstrap.php) anche senza offset; la UI invia ISO con offset.
- Topic esistente ma disattivato: `topicId` azzerato ma il topic resta in uso (reparto, priorità, numerazione, form).
- Datetime dei form salvati come `Y-m-d H:i:s T` nel fuso dell'utente (es. `2026-09-30 02:00:00 CEST`).
- Memo non trimmato; `$thisclient` (EndUser) non dà uid negli eventi (uid NULL, uid_type S); username dell'evento
  `created` dal portale = nome dell'utente; `FA_SetStatus` descrive lo stato cercando un Team.
- Creazione automatica del form proprietà delle liste (vedi punto 2).
- Il messaggio di sistema `ticket.alert` non ha token/separatore (thread non è una ThreadEntry).
- htmLawed `tidy=-1`: spazi compattati in `Format::safe_html` (ora replicato in `safeHtml`).

### 3.5 task, utenti, organizzazioni, profilo agente, 2FA (M3 parte B, area "people")

Fonte: `apps/web/docs/contract/people.md`.

Verificato con i test differenziali (righe DB ed email identiche al PHP; operazioni PHP in `test/diff/php/ops/people.php`):

| File | Scenari |
|---|---|
| `test/diff/tasks.diff.test.ts` | 10 (creazione, note/risposte, assegnazione, claim, trasferimento, stato, modifica, scadenza, eliminazione, massa, avvisi email) |
| `test/diff/people-directory.diff.test.ts` | 9 (utenti: creazione, modifica, organizzazione, eliminazione, import CSV, account, email di attivazione/reset; organizzazioni: creazione, campi, profilo, eliminazione, membri) |
| `test/diff/people-profile.diff.test.ts` | 7 (profilo, validazione, cambio password, reset via email + login con token, 2FA dal profilo, login con 2FA, tentativi falliti + avviso admin) |
| `test/diff/staff-login.diff.test.ts` | 3 (login, invariato) |

```
OST_DIFF_TAG=people MAILPIT_SMTP_PORT=1029 MAILPIT_HTTP_PORT=8029 \
  npx vitest run -c vitest.diff.config.mts test/diff/tasks.diff.test.ts test/diff/people*.diff.test.ts test/diff/staff-login.diff.test.ts
```

I test disattivano `verify_email_addrs` (nessun DNS nell'ambiente). Token casuali (`config.pwreset`), hash delle
password e codici 2FA vengono normalizzati prima del confronto; le password sono verificate con `comparePassword`.

#### File
| Livello | File | Contenuto |
|---|---|---|
| Dominio | `src/server/domain/task/{model,vars,write,tasks}.ts` | task (scritture, avvisi, lista/visibilità) |
| Dominio | `src/server/domain/directory/forms.ts` | form dinamici U/O/A: entry, risposte, `*__cdata`, validazione, verifica DNS email |
| Dominio | `src/server/domain/directory/users.ts` | `createUser`, `updateUser`, `setUserOrganization`, `removeUserFromOrg`, `deleteUser`, `importUsers`, `reindexUser` |
| Dominio | `src/server/domain/directory/accounts.ts` | `registerAccount`, `updateAccount`, `sendUserResetEmail`, `sendUserConfirmEmail`, `massUserAction`, `checkPasswordPolicy` |
| Dominio | `src/server/domain/directory/orgs.ts` | `createOrg`, `updateOrg`, `updateOrgProfile`, `deleteOrg`, `massDeleteOrgs`, `removeOrgUsers`, `addOrgUser` |
| Dominio | `src/server/domain/directory/content-mail.ts` | email da pagine di contenuto (`Page::lookupByType` + `replaceTemplateVariables` + `Email::send`) |
| Dominio | `src/server/domain/directory/ui.ts` | campi dei form per la UI (`toDynFields`, `editFormFields`, `formSource`) |
| Dominio | `src/server/domain/staff/profile.ts` | `updateStaffProfile`, `changeStaffPassword`, `sendStaffResetEmail`, `verifyStaffResetToken`, `setup2faEmail`, `verify2faSetup`, `updateStaffConfig` |
| Auth | `src/server/auth/mfa.ts` | backend 2FA email (`prepare2faEmail`, `validateOtp`, `staff2faConfig`) |
| Auth | `src/server/auth/staff-recovery.ts` | verifica 2FA al login, reset password (richiesta, login con token), sessione dopo cambio password |
| Auth (core, additivo) | `src/server/auth/staff-auth.ts`, `session.ts` | 2FA al login, avviso admin sui tentativi falliti, campi `mfk`/`rst` della sessione |
| Server action | `agent/(panel)/{tasks,users,orgs,profile}/actions.ts`, `agent/login/recovery-actions.ts` | azioni della UI |
| UI | `src/components/people/**`, pagine `tasks`, `users`, `orgs`, `profile`, `login/verify`, `login/reset` | |
| Testi | `src/messages/people/{it,en}.json` | `peopleUi`, `peopleTasks`, `peopleDir`, `peopleProfile`, `peopleAuth` |

#### Convenzioni comuni
- Le scritture passano da `runWrite` (transazione); le email partono dopo il commit (`ctx.after`), tranne login/reset
  (fuori transazione, come il PHP che invia durante la richiesta).
- Form dinamici: `form_entry` (`created/updated = NOW()`), una `form_entry_values` per campo memorizzabile
  (non `EXT_STORED`: `name`/`email` di utenti e org non hanno risposta), valore `NULL` se vuoto per il confronto debole;
  ogni risposta inserita/modificata aggiorna la colonna in `*__cdata` (`INSERT … ON DUPLICATE KEY UPDATE`, scelte →
  chiavi separate da virgola, `NULL` → `''`). In modifica cambiano solo i campi presenti nella sorgente (Widget::getValue).
- Indice `_search`: `U` = risposte (tranne `subject`) + `" "` + indirizzi email uniti da `\n`, titolo = nome;
  `O` = risposte, titolo = nome. Alla creazione la relazione `emails` del PHP contiene l'indirizzo due volte (anche
  in un `setOrganization` nella stessa richiesta): replicato.
- `user.updated = NOW()` e reindicizzazione solo se il modello è "sporco" (`User::save`); il nome assegnato conta come
  modifica anche se la normalizzazione ("Cognome, Nome" → "Nome Cognome") lo riporta uguale.
- `organization.updated` è `ON UPDATE CURRENT_TIMESTAMP`: cambia a ogni UPDATE della riga.

#### Task
Vedi i commenti di `src/server/domain/task/write.ts`. Tabelle: `task` (`number` da `sequence` o casuale),
`task__cdata`, `form_entry(_values)`, `thread` (A), `thread_entry` (M con flag ORIGINAL, N, R), `thread_event`
(`created`, `assigned` con `claim`/`staff`(AgentsName)/`team`, `transferred`, `closed`, `reopened` con annullamento,
`edited`, `deleted`), nota sul ticket collegato (chiusura/riapertura, con riapertura del ticket chiuso), `_search`,
`draft` (`task.%.<id>` all'eliminazione; `task.note|response.<id>` e `task.add` dell'agente dopo la pubblicazione),
`syslog` Debug all'eliminazione. Email: `task.alert`, `task.activity.alert`, `task.assignment.alert`, `task.transfer.alert`.

#### Utenti
| Operazione | Scritture |
|---|---|
| Creazione (`User::fromForm/fromVars`) | `user_email` (`user_id` 0 poi aggiornato), `user` (`org_id` = `org_id` passato o `Organization::forDomain`, `status` 0, nome normalizzato, `created/updated = NOW()`), entry del form "Contact Information" + `user__cdata`, `_search` U |
| Modifica (`User::updateInfo`, staff) | `user_email.address` se cambiato; risposte + cdata; `user` (nome, `updated`) + `_search` se sporco |
| Organizzazione (`setOrganization`) | `user.org_id`, `updated`, `_search` |
| Rimozione dall'org (`Organization::removeUser`) | `user.org_id = 0` (NULL convertito da MySQL), bit `PRIMARY_ORG_CONTACT` tolto, `updated`, `_search` |
| Eliminazione (`User::delete`) | rifiutata con ticket; `user_account`, `user_email`, `form_entry(_values)` (cdata restano), `user`, `_search` |
| Import CSV (`User::importFromPost`) | intestazione `name, email` anteposta al testo incollato; per riga creazione o `updateInfo` dell'esistente (l'`org_id` predefinito vale solo per i nuovi); tutto o niente (SAVEPOINT) |
| Registrazione account (`UserAccount::register`) | `user_account` (`user_id`, `timezone` o NULL, `backend`, `username` sanificato se diverso da `"Nome" <email>`, `passwd` bcrypt, `status` CONFIRMED [+ REQUIRE_PASSWD_RESET/FORBID_PASSWD_RESET]); con `sendemail` nessuna password, `status` 0 ed email di attivazione |
| Gestione account (`UserAccount::update`) | `timezone`, `username` (sanificato), `passwd` + CONFIRMED, bit LOCKED/REQUIRE_PASSWD_RESET/FORBID_PASSWD_RESET da flag; UPDATE solo se cambia qualcosa |
| Blocco/sblocco (massa) | `user_account.status` bit LOCKED |
| Email attivazione/reset (`sendUnlockEmail`) | `config` (`namespace` pwreset, `key` = token 48 caratteri `Misc::randCode`, `value` = `c<user_id>`, `updated`); email pagina `registration-client` / `pwreset-client` dall'email predefinita a `"Nome" <email>`, link `<helpdesk>/pwreset.php?token=…` |

#### Organizzazioni
| Operazione | Scritture |
|---|---|
| Creazione (`Organization::fromForm/fromVars`) | `organization` (`name` striptags, `status` = 8 SHARE_PRIMARY_CONTACT, `created/updated = NOW()`), entry "Organization Information" + `organization__cdata`, `_search` O |
| Campi (`Organization::update`) | nome cambiato → UPDATE + `_search` **prima** delle risposte (indice con le risposte vecchie); risposte + cdata; senza `contacts` tutti i membri perdono il bit di contatto principale (`status & ~1`, senza `updated`) |
| Profilo (`updateProfile`) | come sopra, poi `status` (bit 1/2/4 da flag, 8/16 da `sharing`), `domain`, `manager` (`s<id>`/`t<id>`), `updated` se risposte salvate, `_search`; contatti indicati → `user.status`, `updated`, `_search` per i membri cambiati |
| Eliminazione (`Organization::delete`) | `organization`, `_search`, membri `org_id = 0` (senza `updated`), `form_entry(_values)` (cdata restano) |
| Rimozione membri | `removeUser` per ogni id (anche se l'utente non è membro, come il PHP) |
| Aggiunta utente | esistente → `setOrganization`; nuovo → creazione + `setOrganization` |

#### Profilo agente
| Operazione | Scritture |
|---|---|
| Preferenze (`Staff::updateProfile`) | `config` `staff.<id>` (INSERT o UPDATE se cambiato, `updated`): `datetime_format`, `default_from_name`, `default_2fa`, `thread_view_order`, `default_ticket_queue_id`, `reply_redirect` (Queue/Ticket), `img_att_view` (inline/download), `editor_spacing` (double/single); poi `staff` (nome striptags, email, telefono/cellulare `Format::phone`, interno, firma sanificata, fuso, locale, lingua, righe, aggiornamento, firma predefinita, carta, ferie) con `updated` se cambia qualcosa |
| Cambio password (`changePassword` + `Staff::setPassword`) | password attuale (non con token di reset), conferma, politica (6–128 byte, diversa dall'attuale ignorando le maiuscole); `config` pwreset dell'agente eliminati, `staff.passwd` bcrypt, `change_passwd = 0`, `passwdreset = NOW()`, `updated` |
| Reset via email (`Staff::sendResetEmail`) | `syslog` Warning "Agent Password Reset" (testo sanificato), `config` pwreset (`value` = staff_id), email pagina `pwreset-staff` dall'email di avviso, link `<helpdesk>/scp/pwreset.php?token=…` |
| Login con token (`PasswordResetTokenBackend`) | `staff.change_passwd = 1` + `updated`, poi come il login (`extra.browser_lang`, `lastlogin`, `updated`), token non annullato fino al cambio password |
| 2FA dal profilo (`configure2FA`) | `config` `staff.<id>`.`2fa-email` = `{"config":{"email":…},"verified":0}`, email `email2fa-staff` con il codice; verifica → `verified = time()` |

#### Login agenti
- 2FA email (`default_2fa = 2fa-email` e configurazione presente): stesse scritture del login senza 2FA più l'email
  `email2fa-staff` (codice di 6 cifre, all'email principale dell'agente) dall'email di avviso; sessione "pendente" fino al
  codice (6 minuti, 3 tentativi; poi logout con syslog "Agent logout"). Backend 2FA di plugin: `mfa_unsupported`.
- Tentativi falliti (`StaffAuthStrikeBackend`): `syslog` Warning ogni 3 tentativi; oltre `staff_max_logins` blocco per
  `staff_login_timeout`, `syslog` Warning "Excessive login attempts (<utente>)" e, con `send_login_errors`, email di solo
  testo all'amministratore (`osTicket::alertAdmin`). Testi del log sanificati (`Format::sanitize`), data `M j, Y, g:i a T` UTC.

#### Differenze e bug del PHP
- **Permessi non replicati** (regola più stretta, annotata nel codice):
  - `scp/users.php do=create` non controlla `user.create`; `do=mass_process` e `confirmlink/pwreset` non controllano
    i permessi → `user.manage`/`user.delete`/`user.edit`;
  - `scp/orgs.php` (remove-users, mass delete, import) non controlla i permessi → `user.edit`, `org.delete`,
    `org.create` + `user.create`;
  - `Task::checkStaffPerm` mostra a tutti i task chiusi → accesso solo per reparto/assegnazione (già annotato);
  - `scp/tasks.php a=postreply` non controlla `task.reply` → richiesto.
- **Stranezze replicate**: email doppia nell'indice dei nuovi utenti; `UserAccount::update` non verifica `passwd2`;
  username impostato anche se uguale all'email (confronto con `"Nome" <email>`); `Organization::update` senza `contacts`
  azzera i contatti principali e reindicizza prima di salvare le risposte; `removeUser` non verifica l'appartenenza;
  `changePassword` con token non verifica davvero la finestra di validità (`&&` al posto di `||`); il 2FA invia il codice
  all'email principale e non a quella configurata; `default_2fa` impostato ma non configurato → login senza 2FA.
- **Differenze**: stato 2FA e contatore dei tentativi in memoria del processo (non in `$_SESSION`); finestra del token di
  reset calcolata nel DB (il PHP interpreta l'ora del DB come UTC); traduzioni delle pagine di contenuto non gestite;
  eliminazione dei ticket di un utente (`deleteAllTickets`) non disponibile finché l'area ticketedit non espone
  l'eliminazione del ticket (`deleteUser` accetta `hardDeleteTicket`).

### 3.6 area "portal" (M4: portale clienti)

Fonte: `apps/web/docs/contract/portal.md`.

Riferimenti PHP: root `index.php`, `login.php`, `logout.php`, `view.php`, `account.php`, `pwreset.php`,
`profile.php`, `open.php`, `tickets.php`, `kb/*`; `include/class.auth.php` (UserAuthenticationBackend,
UserAuthStrikeBackend, osTicketClientAuthentication, AccessLinkAuthentication, AuthTokenAuthentication,
ClientPasswordResetTokenBackend, ClientAcctConfirmationTokenBackend), `class.client.php` (TicketUser,
EndUser, ClientAccount), `class.user.php` (User::updateInfo, UserAccount), `class.ticket.php`
(postMessage, onMessage, notifyCollaborators, sendAccessLink, checkUserAccess), `include/client/*.inc.php`.
Diff test: `test/diff/portal-auth.diff.test.ts` (20), `portal-message.diff.test.ts` (12),
`portal-open.diff.test.ts` (5) con le op di `test/diff/php/ops/portal.php`.

#### API

```ts
// Sessione (src/server/auth/client-auth.ts) — cookie firmato `ostn_client` (realm "client"), separato dagli agenti
startClientSession(login: ClientLogin)        currentClient(): ClientIdentity | null   (cache per richiesta)
touchClientSession() clientSessionKey() visitorKey(create?) clientResetToken() refreshClientSession(pwv) clientLogout()

// Autenticazione (src/server/domain/client/auth.ts) — solo dominio, usabili dall'harness
performClientLogin({login, password, ip})            → ClientAuthOutcome
performAccessLink({email, number, ip})               → {ok, sent:true} | {ok, sent:false, ...ClientLogin} | errore
performTokenSignOn({auth | t,e,a, ip})               → ClientAuthOutcome | null
performResetTokenLogin({userid, token, ip})          → ClientAuthOutcome (resetToken in sessione)
performConfirm({token, ip})                          → ConfirmOutcome
lookupByAuthToken(executor, token)  resetTokenValid(executor, cfg, token, userId)

// Account (src/server/domain/client/account.ts)
registerClientAccount(vars, guest?)  requestClientPasswordReset(userid, {pad?})
updateClientProfile(client, vars, resetToken?)  updateUserInfoForClient(tx, cfg, userId, input)

// Ticket (src/server/domain/ticket/message.ts, domain/client/*)
postMessage(ctx, {ticketId, userId, poster, message, files?, origin?, alerts?})   // Ticket::postMessage
postClientMessage(cfg, client, ticketId, {message, files, ip})                    // tickets.php a=reply
editClientTicket(cfg, client, ticketId, vars, ip) / editTicketAsClient(...)        // tickets.php a=edit
openPortalTicket(cfg, client|null, vars, {ip, sessionKey})                        // open.php → createTicket 'web'
clientCanAccess, listClientTickets, clientTicketStats, loadClientTicketView, clientAttachment, clientEditForms
kbEnabled, publicCategories, featuredCategories, searchFaqs, publicCategory, publicFaq, publicFaqFile, contentPage
```

Rotte: pagine in `src/app/[locale]/(client)/**` (`/`, `/login`, `/account`, `/pwreset`, `/profile`, `/tickets`,
`/tickets/[id]`, `/tickets/[id]/edit`, `/open`, `/kb`, `/kb/category/[id]`, `/kb/faq/[id]`); route handler
`/view` (link `?auth=`), `/pwreset/confirm` (conferma account), `/api/portal/upload`, `/api/portal/file/[key]`.

#### Scritture

| Operazione | Righe |
|---|---|
| Login riuscito (client, token, link senza verifica, reset, conferma) | `syslog` Debug "User login" `<email> (<uid>) logged in [<ip>]` (solo con log_level ≥ 3); `user_account.extra` `{"browser_lang":"<lingua di sistema>"}` se l'utente ha un account e il valore cambia; solo login interattivo: `DELETE config` namespace `pwreset` value `c<uid>`; password MD5 legacy → `user_account.passwd` bcrypt `$2a$08$` |
| Login fallito / AccessDenied | contatore per IP (il PHP: per sessione); ogni 3° tentativo `syslog` Warning "Failed login attempt (user)"; oltre `client_max_logins` blocco per `staff_login_timeout` minuti, `syslog` Error "Excessive login attempts (user)" + avviso all'admin (solo testo) se `send_login_errors` |
| Link di accesso (verifica email) | nessuna riga; email pagina `access-link` (to: proprietario con `view.php?auth=`; cc: collaboratore con `tickets.php?id=`) dall'email predefinita, Message-ID classe `?` utente 0 |
| Registrazione (account.php) | utente nuovo come `User::fromVars` (user, user_email, form_entry U + valori + `user__cdata`, `_search` U); utente esistente: `User::updateInfo`; `DELETE config pwreset c<uid>`; `INSERT user_account` (user_id, timezone, lang NULL, passwd, status 0); `INSERT config` pwreset `<token 48>` = `c<uid>`; email `registration-client` |
| Conferma (pwreset.php?token) | `user_account.status \|= 1`; login (sopra); con password locale `DELETE config pwreset c<uid>`, altrimenti `status \|= 4` |
| Richiesta reset | `INSERT config` pwreset `<token>` = `c<uid>`; email `pwreset-client`; nessuna scrittura se l'account non esiste |
| Accesso con token di reset | `user_account.status \|= 4` (REQUIRE_PASSWD_RESET), login (sopra) senza cancellare il token |
| Profilo | `user_account` timezone/lang (solo se cambiano), con nuova password: passwd, `DELETE config pwreset c<uid>`, `status &= ~4`; `User::updateInfo`: `user_email.address`, `form_entry_values` dei campi modificabili dai clienti (`user__cdata`), `user.name` normalizzato + `updated`, `_search` U |
| Messaggio (postMessage) | poster ≠ proprietario e non collaboratore: `thread_collaborator` flag 3 + evento `collab`; `thread_entry` M (recipients = partecipanti attivi tranne il poster, ordine collaboratori per nome; flag REPLY_ALL/REPLY_USER, COLLABORATOR, BALANCED), `_search` H, `attachment` H; `thread.lastmessage`; `ticket` isanswered 0, lastupdate, updated; se chiuso e riapribile `Ticket::reopen` (status, reopened, closed NULL, staff riassegnato, evento `reopened` che annulla `closed`, est_duedate); `DELETE draft` `ticket.client.<id>` (+ allegati D) |
| Modifica ticket (a=edit) | `form_entry_values` dei campi visibili e modificabili dai clienti + `ticket__cdata`; evento `edited` `{"fields":{"<id>":[vecchio,nuovo]}}` con l'utente (uid U) — senza `ticket.updated` né `_search` |
| Apertura (open.php) | `DELETE draft ticket.client.<ultimi 12 della sessione>` (anche se la creazione fallisce) poi `createTicket(ctx, vars, "web")` (vedi `create.md`) |

Email del messaggio (dopo il commit, ordine del PHP): `message.autoresp` al poster (proprietario in To classe U,
collaboratore in Cc classe C; `message_autoresponder` e reparto `message_auto_response`), `ticket.activity.notice`
(una email: proprietario in To, collaboratori in Cc, classe M; saluto "Collaborator" se il proprietario è l'autore),
`message.alert` agli agenti (penultimo rispondente, assegnatario o team, manager del reparto, account manager).

KB: sola lettura, il PHP non registra visualizzazioni (nessuna colonna `faq.views`).

#### Differenze rispetto al PHP (sicurezza, non replicate)
- Strike per IP (in memoria) invece che per sessione: scartare il cookie non azzera il contatore.
- `ClientAccount::update` con token di reset: il PHP non verifica scadenza del token (`&&` al posto di `||`),
  conferma e politica della password; qui token valido e non scaduto, conferma e politica obbligatorie.
- Registrazione/apertura ospite: `Company` legge i propri campi da `$_POST` al primo uso, quindi `%{company.name}`
  nell'email di conferma diventa il nome inviato dal visitatore (contenuto falsificabile verso indirizzi arbitrari);
  Next usa sempre i dati dell'azienda (l'op PHP carica Company prima di `$_POST`).
- Ricerca dei ticket: le note interne non partecipano alla ricerca full-text del cliente.
- Un ospite (link) vede solo il ticket del link; non può modificare il profilo.
- Captcha (`enable_captcha`) non replicato: con il captcha attivo gli ospiti non aprono ticket da Next.
- AccessLinkAuthentication provata nel login con password (password = numero di un proprio ticket): non replicato.

#### Stranezze PHP replicate
- `UserAuthStrikeBackend::authTimeout` usa `staff_login_timeout`, non `client_login_timeout`.
- Ogni tentativo durante il blocco è un nuovo strike (nuovo "Excessive login attempts").
- `ClientPasswordResetTokenBackend::signOn` riceve `$errors` per valore: l'errore mostrato è "Unknown user" (+ strike).
- Il controllo anti-loop dell'auto-risposta (`Email::getIdByEmail('"Nome" <email>')`) non trova mai un'email di sistema.
- `getChanges` della modifica cliente include anche i campi non visibili/modificabili assenti dal POST (es. priorità → null) nell'evento, ma salva solo i campi del cliente.
- Testo semplice: doppia pulizia del corpo (tickets.php + ThreadEntry::create) senza doppia codifica.
- `user_account` non ha `lastlogin`: il PHP non registra l'ultimo accesso dei clienti.
- Lingua `browser_lang`: lingua di sistema (la negoziazione con Accept-Language non è replicata).

### 3.7 area amministrazione: impostazioni, reparti, help topic, SLA, orari, agenti, team, ruoli (M5 parte A, area "admin")

Fonte: `apps/web/docs/contract/admin.md`.

Verificato con i test differenziali (righe DB ed email identiche al PHP; operazioni PHP in `test/diff/php/ops/admin.php`):

| File | Scenari |
|---|---|
| `test/diff/admin-settings.diff.test.ts` | 8 (sistema: modifica + chiavi mancanti + salvataggio identico; errori titolo/ACL/backend; ticket con autorisposte, avvisi e ordine code; errori formato/destinatari e validazione tardiva; task; agenti e utenti con errori; KB; azienda: form "C", pagine, loghi; errori) |
| `test/diff/admin-departments.diff.test.ts` | 7 (modifica con accessi estesi/ruolo membri primari; rimozione accessi; creazione sotto-reparti; errori; massa; eliminazione con spostamenti; reparto usato da un filtro) |
| `test/diff/admin-objects.diff.test.ts` | 10 (help topic: modifica con form/ordinamento, creazione, errori, massa + ordinamento manuale; SLA: modifica/creazione/errori, massa ed eliminazione; team: modifica/creazione/errori, massa ed eliminazione; ruoli: modifica/creazione/errori, massa ed eliminazione) |
| `test/diff/admin-agents.diff.test.ts` | 5 (modifica completa; creazione con email di benvenuto e con password; errori e "ultimo amministratore"; password impostata e email di reset con syslog; massa: abilita/disabilita, permessi, reparto con eavesdrop, eliminazione) |
| `test/diff/admin-schedules.diff.test.ts` | 4 (nuovo orario e clonazione; modifica con festività e ordine voci; voci annuali/settimanali/mensili/una tantum, modifica e conflitti; eliminazione voci e orari) |

```
OST_DIFF_TAG=admin MAILPIT_SMTP_PORT=1031 MAILPIT_HTTP_PORT=8031 \
  npx vitest run -c vitest.diff.config.mts test/diff/admin-*.diff.test.ts
```

Unit test: `test/unit/admin-php.test.ts` (FormData → `$_POST`, semantica PHP, JSON dei permessi).
I test degli agenti disattivano `verify_email_addrs` (nessun DNS). Token di reset normalizzati, password verificate con
`comparePassword`.

#### File
| Livello | File | Contenuto |
|---|---|---|
| Dominio | `src/server/domain/admin/php.ts` | semantica PHP sui `$vars` del POST: `isset`, `truthy`, `intval`, `isNumeric`, `formatHtmlchars` (Format::htmlchars), `usernameError` |
| Dominio | `src/server/domain/admin/orm.ts` | `OrmRow`: dirty tracking di VerySimpleModel (confronto debole, INSERT dei soli campi impostati, `updated = NOW()` se modificato) |
| Dominio | `src/server/domain/admin/config-write.ts` | `ConfigWriter` = Config::update/updateAll |
| Dominio | `src/server/domain/admin/validator.ts` | Validator::process (int, string, email, cs-url, cs-domain, ipaddr) |
| Dominio | `src/server/domain/admin/settings.ts` | `updateSettings` (OsticketConfig::updateSettings e update*Settings), `settingsValues`, `installedLanguages` |
| Dominio | `src/server/domain/admin/company.ts` | form azienda (tipo C): `validateCompanyForm`, `saveCompanyForm`, `companyValues` |
| Dominio | `src/server/domain/admin/dept.ts` | `saveDept`, `deleteDept`, `massDept`, `deptFullPath` |
| Dominio | `src/server/domain/admin/topic.ts` | `saveTopic`, `deleteTopic`, `massTopics`, `helpTopicsSnapshot`, `sortByName` |
| Dominio | `src/server/domain/admin/sla.ts` | `saveSla`, `deleteSla`, `massSla` |
| Dominio | `src/server/domain/admin/schedule.ts` | `addSchedule`, `updateSchedule`, `deleteSchedules`, `saveScheduleEntry`, `deleteScheduleEntries`, `processEntryForm`, `effectiveTimezone` |
| Dominio | `src/server/domain/admin/staff-admin.ts` | `saveStaff`, `setAgentPassword`, `sendAgentResetEmail`, `deleteStaff`, `massStaff`, `AGENT_PERMISSIONS` |
| Dominio | `src/server/domain/admin/team.ts` | `saveTeam`, `deleteTeam`, `massTeams` |
| Dominio | `src/server/domain/admin/role.ts` | `saveRole`, `massRoles`, `roleInUse`, `ALL_PERMISSIONS`, `rebuildPermissions` |
| Dominio | `src/server/domain/admin/filters.ts` | `filterActionsReferencing` (vedi "Filtri") |
| Dominio | `src/server/domain/admin/{common,lookups,dashboard,form-data}.ts` | esiti, elenchi per i form, sintesi della home, `parsePhpForm` |
| Server action | `admin/{departments,topics,sla,schedules,agents,teams,roles}/actions.ts`, `admin/settings/_shared/actions.ts`, `admin/_shared/server.ts` | `requireAdminAction` (solo `isadmin`), transazione, email dopo il commit |
| UI | `admin/page.tsx`, `admin/settings/{company,system,tickets,tasks,agents,users,kb}`, `admin/{departments,topics,sla,schedules,agents,teams,roles}/**` | pagine con `requireAdmin` |
| UI | `src/components/admin/{AdminForm,AccessEditor,AdminList,MassBar,AdminNotice}.tsx`, `src/lib/admin/form-schema.ts` | form a schema, liste con azioni di massa |
| Testi | `src/messages/admin/{it,en}.json` | `admUi`, `admSettings`, `admDepts`, `admTopics`, `admSla`, `admSchedules`, `admAgents`, `admTeams`, `admRoles`, `admHome` |

#### Convenzioni comuni
- Le funzioni di dominio ricevono le stesse `$vars` del POST di scp/*.php (`PhpVars`: stringhe, liste `x[]`, mappe `x[k]`);
  la UI invia FormData con gli stessi nomi e `parsePhpForm` le ricostruisce.
- Modelli (department, help_topic, sla, team, role, staff, schedule, schedule_entry): un campo è modificato solo se cambia
  con confronto debole PHP (`OrmRow.set`), l'UPDATE contiene solo quei campi più `updated = NOW()`; le INSERT contengono solo
  i campi impostati (un valore "uguale a NULL" come `0`/`''` non è impostato e prende il default della colonna).
- `config` (Config::update): UPDATE solo se il valore cambia (confronto debole) con `updated = NOW()`; INSERT se la chiave
  manca (valore `''` se "uguale a NULL"); booleani scritti come `1`/`0`.
- Nessuno di questi oggetti è indicizzato in `_search` (MysqlSearchBackend indicizza solo ticket, voci, utenti, org e FAQ) e
  nessuna scrittura genera `thread_event`; i Signal `object.created/edited` non hanno ascoltatori nel core.
- Azioni di massa con `UPDATE` diretto (abilita/disabilita SLA, team, ruoli, agenti): solo `flags`/`isactive`, senza `updated`.

#### Impostazioni (scp/settings.php → OsticketConfig::updateSettings)
Namespace `core`. Pagine: `system`, `tickets` (con autorisposte, avvisi e `qsort[queue_id]`), `tasks`, `agents`, `users`,
`kb`, `pages` (= "Azienda"). Chiavi e valori come `update*Settings`; in particolare:
- sistema: `$vars` passano da `Format::htmlchars($vars, true)` (sanitize + htmlspecialchars senza doppia codifica);
  ACL: con backend diverso da 0/2 l'IP del client deve essere nell'elenco; `default_storage_bk` aggiornato prima degli altri;
  lingue secondarie filtrate su quelle installate (`include/i18n` dell'installazione PHP); `force_https` = `on`/`''`;
  `acl_backend` = `Format::sanitize((int))` o `0`.
- ticket: autorisposte e avvisi sono salvati **prima** della validazione dei campi principali (se poi fallisce restano
  salvati: stranezza replicata); ordine delle code (`queue.sort`, `updated = NOW()` se cambia) tra le code con FLAG_QUEUE.
- azienda: form dinamico tipo `C` (entry con `object_type 'C'`): validazione dei campi obbligatori per l'agente, poi
  `form_entry_values` aggiornati solo se cambiano (nessun `form_entry.updated`, nessun `*__cdata`); `client_logo_id`,
  `staff_logo_id`, `staff_backdrop_id` = id scelto o `false` (→ `0`/`''`).
- Errori come codici (`required`, `invalid`, `hash`, `recipients`, `lockout`, `ip_required`, `inactive`…).

#### Reparti (Dept)
- `department`: tutti i campi del form; `flags` ricostruiti da zero (quindi sempre "modificati": ogni salvataggio aggiorna
  `updated`); `path` = percorso degli antenati, per un reparto nuovo prima `//` (o `<padre>/`) e poi un secondo UPDATE con l'id.
- Accessi: `staff_dept_access` (nuovo: `staff_id`, `role_id`, `dept_id`, `flags` solo se 1 — con avvisi disattivati la riga
  nuova prende il default 1 della colonna: stranezza del PHP replicata), ruolo/avvisi aggiornati, accessi non più elencati
  eliminati; ruolo dei membri primari salvato in `staff.role_id` (+ `staff.updated`).
- Eliminazione: non il predefinito né con membri; ticket, task e agenti → reparto predefinito; help topic ed email → 0;
  accessi estesi eliminati. Massa: enable/disable/archive (flag + `updated`); `make_public`/`make_private` del PHP usano la
  colonna inesistente `dept_id` e falliscono sempre (non offerte nella UI).

#### Help topic (Topic)
- `help_topic` come Topic::update (assegnazione `s<id>`/`t<id>`, numerazione personalizzata con FLAG_CUSTOM_NUMBERS,
  stato con FLAG_ACTIVE/ARCHIVED, `noautoresp`, note sanificate); nuovo sotto-topic: `sort = sort del padre + 1`.
- Ordinamento alfabetico (`help_topic_sort_mode` = `a`): `INSERT … ON DUPLICATE KEY UPDATE sort` con l'elenco letto
  **prima** del salvataggio (cache statica di getHelpTopics): un topic nuovo o rinominato non conta nella stessa richiesta.
  Collator della lingua principale (Intl.Collator).
- `help_topic_form`: form nell'ordine inviato (`sort = indice+1`), `extra = {"disable":[id campi non spuntati]}`, rimozione
  dei form non più elencati (tranne il tipo T).
- Eliminazione: non il predefinito; figli → `topic_pid 0`, `faq_topic` eliminati, ticket → `topic_id 0`; le righe
  `help_topic_form` restano (come nel PHP). Massa: almeno un topic attivo; ordinamento manuale con `sort-<id>`
  (al primo passaggio a "manuale" la chiave nuova non è letta dal PHP nella stessa richiesta: l'ordine inviato è ignorato).
- La propagazione dello stato "disabilitato" dai padri segue la stranezza di getHelpTopics (solo dal secondo livello).

#### SLA
`sla` con `$vars` passati da Format::htmlchars (nome e note salvati con le entità HTML); flags = attivo | NOALERTS |
TRANSIENT. Eliminazione: non il predefinito; reparti/topic → `sla_id 0`, ticket → SLA predefinito.

#### Orari (Schedule)
- Nuovo/clonazione (ajax.schedule.php): INSERT con `created/updated`, poi UPDATE di `flags` (tipo) e `updated`; clonazione
  delle voci (`created/updated = NOW()`).
- Modifica: nome, fuso (`NULL` se vuoto), descrizione sanificata; `config schedule.<id>` → `configuration`
  `{"holidays":["4"]}` (id come stringhe del POST); `schedule_entry.sort` da `sort-<id>`.
- Voci (ScheduleEntryForm::process): la data del datepicker è letta come mezzanotte UTC e convertita nel fuso dell'agente
  (o di sistema): `starts_on` è il giorno in quel fuso (nei fusi a ovest di UTC il giorno prima, come il PHP), `stops_on` è
  data e ora in quel fuso; tutto il giorno = 00:00:00–23:59:59; `ends_at` con secondi 59 se i minuti non sono 00;
  `day/week/month` per settimanale/mensile/annuale; unicità come Schedule::isEntryUnique. In modifica si impostano solo
  le chiavi calcolate (le vecchie `day/week/month` restano: stranezza replicata).
- Eliminazione: orario e voci (la config `schedule.<id>` resta).

#### Agenti (Staff)
- `staff` come Staff::update: `isadmin`, `isactive` (= non bloccato), **`isvisible = 0` a ogni salvataggio** (il form PHP
  non ha il campo: stranezza replicata; su un agente nuovo 0 non è impostato e resta il default 1), `onvacation`,
  `assigned_only`, dati anagrafici (telefono con Format::phone), note, `permissions` (RolePermission JSON o `''` se nessuno),
  `extra.def_assn_role`, password (`passwd`, `change_passwd`, `passwdreset = NOW()`, token `pwreset` dell'agente eliminati).
- Reparto primario (setDepartmentId: rimuove l'eventuale accesso esteso a quel reparto), accessi estesi (`staff_dept_access`
  salvati uno per uno), team (`team_member`).
- Controllo "unico amministratore attivo": confronta con l'id dell'ultima ricerca per username/email (`$uid`), quindi se
  cambia anche l'email il controllo non scatta (stranezza replicata).
- Creazione: senza password e con backend locale → email di benvenuto (`registration-staff`, token in `config pwreset`,
  nessun syslog); con password: PasswordResetForm (obbligatoria, politica, conferma).
- ajax.staff.php setPassword: email `pwreset-staff` (syslog Warning "Agent Password Reset" con `Requested-User-Id` vuoto)
  oppure nuova password (+ `change_passwd` facoltativo).
- Eliminazione (non se stessi): ticket → `staff_id 0`, `thread_entry.staff_id = 0` con `poster = "Nome Cognome"`,
  team e accessi eliminati; i task assegnati restano (come nel PHP).
- Massa: attiva/blocca (`isactive`, senza `updated`), permessi (senza permessi il PHP non salva), reparto (con eavesdrop:
  accesso esteso al vecchio reparto con avvisi), elimina.

#### Team e ruoli
- `team`: flags = abilitato | NOALERTS, capo team azzerato se rimosso (`remove[]`), membri `team_member` (avvisi = flag 1).
  Eliminazione: membri eliminati, ticket → `team_id 0`.
- `role`: nome e note sanificati, `permissions` JSON: chiavi esistenti nel loro ordine, nuove in coda nell'ordine di
  RolePermission::allPermissions (gruppo, titolo); almeno un permesso. Eliminazione solo se nessun agente o accesso usa il ruolo.

#### Filtri (differenza voluta)
`Signal object.deleted → Filter::disableFilters` va in errore fatale nel PHP quando un'azione di filtro fa riferimento
all'oggetto eliminato (reparto, topic, agente, team, SLA): la riga principale viene cancellata ma ticket/task/accessi
non vengono aggiornati (dati orfani). In TS l'eliminazione viene **rifiutata senza scritture** (errore `filter`).
Il riallineamento dei flag dei filtri al cambio di stato (FilterAction::setFilterFlags) nel PHP non scrive mai nulla
(Filter::update fallisce per le regole mancanti): niente da replicare.

#### Permessi (differenze di sicurezza)
- ajax.schedule.php (nuovo orario, voci) richiede solo un agente autenticato: qui tutte le scritture admin richiedono `isadmin`
  (pagine con `requireAdmin`, server action con `requireAdminAction`).

#### Non gestito (resta al PHP)
- Caricamento ed eliminazione di loghi/sfondi (`AttachmentFile::uploadLogo/uploadBackdrop/delete`): la pagina Azienda
  permette solo di scegliere tra i file già caricati.
- Traduzioni dei nomi (CustomDataTranslation) di reparti, topic, SLA, team, ruoli e voci degli orari.
- Esportazione CSV degli agenti/membri del reparto; importazione agenti; "ferie di massa" (non esiste nel PHP).

### 3.8 area "adminsys" (M5 parte B)

Fonte: `apps/web/docs/contract/adminsys.md`.

Amministrazione di sistema: email, ban list, template, diagnostica, filtri, form, liste, pagine, code,
API key, log, plugin, informazioni di sistema. Solo amministratori: `requireAdmin(locale)` in ogni
pagina, `requireAdminAction()` (sessione + `isadmin`) in ogni server action. Scritture in transazione
(`adminWrite`). Servizi in `src/server/domain/adminsys/*`, verificati con i test differenziali
`test/diff/adminsys-*.diff.test.ts` (op PHP in `test/diff/php/ops/adminsys.php`).

Convenzioni comuni:
- `Format::sanitize` → `sanitizeHtml` (`adminsys/sanitize.ts`): `sanitizeText` + attributi obbligatori di
  htmLawed (`<img>` senza alt → `alt="image"`, senza src → `src="src"`, `<bdo>` → `dir="ltr"`).
- Modelli ORM con `OrmRow` dell'area admin: INSERT con i soli campi "dirty" (confronto debole PHP),
  UPDATE dei soli campi cambiati, `updated = NOW()` se il modello lo prevede.
- `db_affected_rows()` di mysqli conta le righe cambiate: i conteggi delle azioni di massa con UPDATE
  diretto si calcolano sulle righe che cambiano davvero.
- Nessun DDL (vedi Form).

#### Impostazioni email — `/admin/settings/emails` (scp/emailsettings.php)
`updateEmailsSettings(tx, vars)` = `OsticketConfig::updateEmailsSettings`.
- Validazione: `default_template_id`, `default_email_id`, `alert_email_id` (int obbligatori),
  `admin_email` (email obbligatoria, non può essere un'email di sistema), `reply_separator` obbligatorio
  se `strip_quoted_reply`.
- `config` (namespace `core`) con `Config::update`: UPDATE `value`, `updated=NOW()` solo se il valore
  cambia; INSERT se la chiave manca (`verify_email_addrs`, `accept_unregistered_email`,
  `add_email_collabs` nella fixture). Chiavi: default_template_id, default_email_id, alert_email_id,
  default_smtp_id, admin_email, reply_separator; flag 1/0 (isset): verify_email_addrs, enable_auto_cron,
  enable_mail_polling, strip_quoted_reply, use_email_priority, accept_unregistered_email,
  add_email_collabs, email_attachments.

#### Account email — `/admin/emails` (scp/emails.php, ajax.email.php)
`saveEmail(tx, id|null, vars)` = `Email::update` / `Email::create`.
- `email`: `email` (sanitize), `name` (striptags), `dept_id`, `priority_id`, `topic_id`, `noautoresp`,
  `notes` (sanitize); nuova: `created=NOW()`; `updated=NOW()` se cambia qualcosa.
- Email esistente: `email_account` mailbox e smtp creati se mancanti (`created`, `type`, `updated`,
  `email_id`) e salvati da `setInfo` se valido (active, host, port, protocol, auth_bk, folder,
  fetchfreq, fetchmax, postfetch, archivefolder / allow_spoofing, protocol=SMTP; azzera
  last_activity, last_error_msg, num_errors). La mailbox viene salvata anche se poi l'SMTP fallisce.
- Account attivo con credenziali: connessione di prova (IMAP/POP3 login e cartelle, SMTP con
  nodemailer `verify`) → errori `mailbox_auth`/`smtp_auth` senza scritture.
- Credenziale con tipo sconosciuto: `logActivity` (num_errors+1, last_error_msg, last_error=NOW()).
- `saveBasicAuth(tx, id, type, {username, passwd}, stash)` = `saveAuth('basic')`: verifica la
  connessione, poi `config` namespace `email.<eid>.account.<aid>`: `username`, `passwd` =
  `Crypto::encrypt(pw, SECRET_SALT, md5(username . namespace))`; account `auth_bk='basic'` + host/porta/
  protocollo dello stash, `updated=NOW()` (INSERT se l'account non esisteva).
  - Bug PHP replicati: account non salvato → namespace `account.0`; SMTP con `auth_bk` salvato
    "mailbox" → credenziali scritte nel namespace della mailbox (cifrate con quello SMTP).
- `massDeleteEmails`: non l'email predefinita né quella degli avvisi; DELETE `email`, `config` dei due
  account, `email_account`; `department.email_id` → email predefinita, `autoresp_email_id` → 0.
  **Differenza**: se un'azione di filtro "email" usa l'indirizzo come `from` il PHP va in errore fatale
  dopo la DELETE (dati orfani): Next rifiuta l'eliminazione (`referenced_by_filter`).
- OAuth2 non gestito (`oauth_unsupported`).

#### Ban list — `/admin/banlist` (scp/banlist.php)
Filtro `SYSTEM BAN LIST` (se manca: errore `no_banlist`, la creazione resta al PHP).
- Aggiunta: `filter_rule` (filter_id, what=email, how=equal, val trim, isactive, notes sanitize,
  created=NOW(), updated=NOW()); duplicati rifiutati.
- Modifica: `FilterRule::update` (val, isactive int (default 1), notes) con `updated=NOW()` se cambia.
- Massa: enable/disable con `UPDATE … SET isactive` (senza `updated`); delete per id del filtro.

#### Template — `/admin/templates` (scp/templates.php)
- Set nuovo: INSERT `email_template_group` (created, updated, name striptags, isactive, notes
  sanitize, lang); clonazione: INSERT…SELECT dei messaggi del set sorgente (created/updated NOW).
- Set modificato: UPDATE sempre con `updated=NOW()`; set in uso (reparti o predefinito) non
  disattivabile.
- Massa: enable (UPDATE isactive=1), disable (`updated=NOW(), isactive=0`, non se in uso), delete (non
  se in uso: set, `department.tpl_id=0`, allegati T dei messaggi, messaggi).
- Messaggio (`updatetpl`): UPDATE `updated=NOW()`, `subject` (non sanificato), `body` (sanitize);
  allegati inline T con il bug di `keepOnlyFileIds` (lista per indice); bozze `tpl.<code>.<tpl_id>`
  (allegati delle bozze e bozze).
- Messaggio mancante (`implement`): INSERT `email_template`, allegati inline dei file citati, bozze
  `tpl.<code><tpl_id>` dell'agente (namespace senza punto, come il PHP).
- "Carica il testo di sistema": solo UI (YAML iniziale dell'installazione PHP), salvato con updatetpl.

#### Diagnostica — `/admin/emails/diagnostic` (scp/emailtest.php)
`sendTestEmail`: `sendMail` con l'email di sistema scelta, corpo sanificato, Message-ID classe "?",
senza thread; poi bozze `email.diag`. Email identica al PHP (verificata via Mailpit).

#### Filtri — `/admin/filters` (scp/filters.php)
`saveFilter(tx, id|null, vars)` = `Filter::update`:
- `filter`: isactive, flags, target (`Email` se il target è un id email → `email_id`), name,
  execorder, email_id, match_all_rules, stop_onmatch, notes (sanitize); `created` (nuovo),
  `updated=NOW()` se cambia.
- `filter_action`: `N<tipo>` INSERT (type, filter_id, sort=indice, configuration JSON, updated),
  `I<id>` aggiorna configuration/sort, `D<id>` DELETE. Configurazione come i form delle TriggerAction:
  ChoiceField → numero (JsonDataParser), testi striptags, messaggio sanitize, `[]` se vuota.
- `filter_rule`: tutte cancellate e reinserite (what, how, val; `created` vuoto, isactive/notes di
  default); regex senza delimitatori avvolte in `/…/iu`.
- Stranezze replicate: senza `actions[]` nessun salvataggio e nessun errore; valore d'azione vuoto →
  errore e stop; ultima azione esistente → `setFlag` ×3 (tre `Filter::update` sui dati del modello che
  ricreano le regole); errori di configurazione in `save_actions` → salvataggio parziale (azioni
  successive con configuration NULL, regole non salvate). `prepareSupportedMatches` (form L delle liste).
- Massa: enable/disable (`updated=NOW()`), delete (filtro, regole, azioni; mai la ban list).

#### Form — `/admin/forms` (scp/forms.php)
`saveForm(tx, id|null, POST)`; POST passato per `Format::htmlchars($_POST, true)`.
- `form` (title, notes, instructions decodificate) salvato subito in update; `form_field` esistenti
  (label, sort, type/name se non mascherati) e nuovi (sort, label, type, name, flags dalla modalità di
  visibilità, created) salvati solo senza errori; eliminazioni immediate (risposte presenti → campo
  staccato `form_id=0`, altrimenti DELETE; `delete-data` cancella `form_entry_values`).
- **DDL**: nei form T, A, U, O un campo nuovo o un cambio di nome/tipo farebbe ricreare al PHP la
  tabella `*__cdata` (Signal model.created/updated). Next rifiuta prima di scrivere (`ddl_required`).
- Eliminazione (massa): logica, `flags |= DELETED` solo con `FLAG_DELETABLE`.
- Configurazione dei singoli campi e traduzioni restano al PHP.

#### Liste — `/admin/lists` (scp/lists.php, ajax.forms.php)
- Lista nuova: `list` (name, name_plural, sort_mode, notes sanitize; htmlchars) + form `L<id>`
  ("<nome> Properties"); proprietà nuove = `form_field` (flags 12289).
- Modifica: campi cambiati della lista, ordinamento manuale degli elementi (`sort-<id>`), proprietà
  (etichetta, ordine, nome, tipo, eliminazione).
- Eliminazione: non se usata da un campo `list-<id>`; DELETE lista, form L segnato DELETED, campi del
  form eliminati (elementi lasciati come nel PHP). **Più stretto**: liste con MASK_DELETE non eliminate.
- Elementi: aggiunta (status 1, list_id, value trim, extra, properties JSON `{id campo: valore}` o
  `[]`; un valore esistente riusa l'elemento), modifica (value, extra NULL se vuoto, properties; il
  controllo di unicità del PHP non blocca mai), enable/disable (bit status), delete (`list_id=NULL`).
- Proprietà gestite: campi `text` e `memo`; altri tipi → `unsupported_property`. Lista degli stati dei
  ticket (handler) in sola lettura. Import CSV al PHP.

#### Pagine — `/admin/pages` (scp/pages.php)
- `content`: type, name (striptags), body/notes (sanitize), isactive 1/0, created/updated.
- Allegati inline P con `keepOnlyFileIds(array_flip(…))` (dal 2° file nuovo il nome è l'indice).
- Bozze: dopo add `deleteForNamespace('page')`, dopo update `page.<id>%`.
- Massa: pagine predefinite protette (salvo enable); enable `UPDATE isactive=1`; disable (già
  disattive contano, in uso no, `updated=NOW()`); delete se non in uso. Traduzioni al PHP.

#### Code — `/admin/queues` (scp/queues.php)
Creazione/modifica (criteri, colonne, ordinamenti, esportazioni) al PHP. Massa: enable/disable
(`flags` ± DISABLED, `updated=NOW()`), delete (solo la riga `queue`; non la coda predefinita).

#### API key — `/admin/apikeys` (scp/apikeys.php)
INSERT/UPDATE `api_key` con SQL diretto: `updated=NOW()`, isactive, can_create_tickets,
can_exec_cron ('' se assenti → 0), notes; alla creazione `created`, `ipaddr` (IPv4/IPv6 valido),
`apikey` casuale 48 caratteri [A-Z0-9]. Massa: enable/disable (UPDATE isactive), delete.

#### Log — `/admin/logs` (scp/logs.php)
Elenco con filtri (tipo, intervallo date, ordinamento, pagine). Eliminazione: `DELETE FROM syslog
WHERE log_id IN (…)`.

#### Plugin — `/admin/plugins` (scp/plugins.php)
Elenco; enable/disable plugin (`UPDATE plugin SET isactive`) e istanze (`flags | 1`, `flags & ~1`).
Installazione, disinstallazione, configurazione ed eliminazione delle istanze richiedono il codice PHP.

#### Sistema — `/admin/system`
Sola lettura: versione osTicket (bootstrap.php), Next/Node, MySQL, schema, spazio, fuso del DB.
<!-- END contratti per area -->
