# Contratto di scrittura — infrastruttura, nota interna, risposta agente (M2.1–M2.2)

Verificato con `test/diff/ticket-post.diff.test.ts`: 7 scenari, righe DB ed email identiche al PHP.

## ThreadEntry::create (`src/server/domain/thread/write.ts`)

### Riga `thread_entry`
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

### `flags`
Valore di partenza: 0. Si aggiungono:
- `0x40` BALANCED se `html`;
- `0x80` SYSTEM se non c'è autore;
- `0x20` COLLABORATOR se l'utente è collaboratore;
- `0x100` REPLY_ALL se i destinatari sono più di uno, altrimenti `0x200` REPLY_USER.

### `body`
`editor_spacing` (`<p></p>` → `<p><br></p>`), poi `Format::sanitize` (htmLawed), `strip_emoticons`. Se il risultato è vuoto si salva `-`. Infine `stripExternalImages`.

### `_search`
`REPLACE (H, id, title, content)` solo se l'autore è un agente o un utente. `content` = HTML con i tag trasformati in spazi, entità decodificate, spazi compressi.

## postNote (Ticket::postNote)
1. Crea l'entry `N` come sopra.
2. Se è indicato `note_status_id`: `setStatus`.
3. `onActivity` ("New Internal Note"): avvisi `note.alert` se `note_alert_active` (vedi sotto).

## postReply (Ticket::postReply)
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

## Ticket::save (`TicketRecord`)
- Si scrivono solo i campi cambiati (confronto debole PHP), con `updated = NOW()`.
- Poi si reindicizza `_search` (T): `title` = "numero oggetto", `content` = risposte indicizzabili del form, una per riga.

## Ticket::setStatus (`status.ts`)
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

## Eventi (`events.ts`)
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

## Avvisi attività (onActivity, template `note.alert`)
Condizioni: `note_alert_active` e almeno un membro del reparto disponibile.

Destinatari:
- penultimo agente che ha risposto (`note_alert_laststaff`);
- assegnatario e membri del team con flag alert (`note_alert_assigned`);
- manager del reparto (`note_alert_dept_manager`).

Esclusi: agenti non disponibili, l'autore, i duplicati per email e, se il ticket è chiuso, gli agenti senza accesso.

Doppia sostituzione come il PHP (`staff-alerts.ts`): prima `note`/`activity`/`comments` (+ ticket, url, company), poi
`%{recipient}` sul messaggio risultante, per cui anche le variabili scritte nel testo della nota (es. `%{ticket.number}`)
vengono risolte (scenario in `ticket-post.diff.test.ts`). Anche `message.alert` (portale) usa lo stesso ciclo condiviso.

Invio dall'email di alert (`alert_email_id`) con header `Auto-Submitted: auto-generated`.

## Email (`src/server/mail/mailer.ts`)
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

## Lock (`lock.ts`)
- Riga `lock`: `created = NOW()`, `staff_id`, `expire = NOW() + autolock_minutes`, `code` = 10 caratteri casuali.
- `ticket.lock_id` aggiornato, con `updated = NOW()` come `Ticket::save`. Il rilascio elimina la riga e azzera `lock_id`.
- Modalità `ticket_lock`: 1 alla visualizzazione, 2 all'attività (default).
