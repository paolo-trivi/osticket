# 17 — Contratto di scrittura (coesistenza PHP ↔ Next.js)

Questo documento elenca, **operazione per operazione**, le righe che osTicket PHP scrive nel database. La nuova app Next.js (`frontend-next/`) deve produrre **le stesse righe**, così il pannello PHP continua a funzionare sugli stessi dati.

Ogni voce è verificata dall'**harness differenziale** (`frontend-next/test/diff/`, comando `npm run test:diff`):
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

## 2. Operazioni da specificare (backlog per milestone)

Per ognuna, prima di implementarla, aggiungere qui la tabella delle scritture (dal codice `include/class.*.php`) e uno scenario in `test/diff/`.

| Milestone | Operazione | Metodo PHP di riferimento |
|---|---|---|
| M2 | risposta agente | `Ticket::postReply` |
| M2 | nota interna | `Ticket::postNote` |
| M2 | cambio stato / chiusura / riapertura | `Ticket::setStatus` |
| M2 | assegnazione, claim, rilascio | `Ticket::assign`, `claim`, `release` |
| M2 | trasferimento, referral | `Ticket::transfer`, `refer` |
| M2 | lock | `Lock::acquire`, `Ticket::acquireLock` |
| M2 | modifica campi, priorità, SLA, scadenza | `Ticket::update`, `updateField` |
| M2 | merge / link | `Ticket::merge`, `link` |
| M2 | cancellazione | `Ticket::delete` |
| M2 | bozze | `Draft::create/update` |
| M2 | allegati | `AttachmentFile::create`, `Attachment` |
| M3 | creazione ticket (tutte le origini) | `Ticket::create`, `Ticket::open` |
| M3 | task | `Task::create`, `Task::setStatus`… |
| M3 | utenti e organizzazioni | `User::fromVars`, `UserAccount::register`, `Organization::fromVars` |
| M4 | messaggio del cliente dal portale | `Ticket::postMessage` |
| M4 | registrazione / reset password cliente | `UserAccount`, `ClientPasswordResetTokenBackend` |
| M5 | ogni salvataggio dell'area admin | `*::update` delle classi admin, `OsticketConfig::updateSettings` |

<!-- BEGIN contratti per area (generato da docs/contract/*.md) -->
## 3. Contratti per area (Next.js)

Sezione generata dai file `frontend-next/docs/contract/*.md`: ogni area documenta le righe scritte e le differenze volute rispetto al PHP. Ogni operazione è coperta da scenari in `frontend-next/test/diff/`.

### 3.1 infrastruttura, nota interna, risposta agente (M2.1–M2.2)

Fonte: `frontend-next/docs/contract/core.md`.

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

Fonte: `frontend-next/docs/contract/actions.md`.

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

#### Stranezze PHP replicate (annotate nel codice)
- `est_duedate` non ricalcolata quando il trasferimento cambia lo SLA.
- Due salvataggi separati (e due `updated`) nel rilascio di agente e team.
- Evento **assigned** con il nome *originale* `first last` anche se il formato dei nomi è diverso.
- `Ticket::getLastRespondent` usa la *penultima* risposta di un agente (`LIMIT 1,1`).
- `deleteDrafts` usa una LIKE in cui il `%` del namespace è escapato.
- `markAs`: in caso di errore di `markUnAnswered()` il PHP scrive `$errors['err'] - __(...)` (sottrazione invece di
  assegnazione), quindi l'errore non viene impostato. Il caso non è raggiungibile con un ticket valido.

### 3.3 area "create" (M3 A: creazione ticket e allegati)

Fonte: `frontend-next/docs/contract/create.md`.

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

### 3.4 task, utenti, organizzazioni, profilo agente, 2FA (M3 parte B, area "people")

Fonte: `frontend-next/docs/contract/people.md`.

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
<!-- END contratti per area -->
