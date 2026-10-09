# 10 — API REST, CLI di integrazione, rotte AJAX e protocollo client/server

## 1. API HTTP pubblica (`/api/http.php`)

### 1.1 Rotte
| Metodo | Path | Controller | Permesso API key |
|---|---|---|---|
| POST | `/api/http.php/tickets.json` (o `/api/tickets.json` con rewrite) | `TicketApiController::create('json')` | `can_create_tickets` |
| POST | `/api/tickets.xml` | `create('xml')` | `can_create_tickets` |
| POST | `/api/tickets.email` | `create('email')` (email RFC822 grezza nel body → nuovo ticket **o risposta** a thread esistente) | `can_create_tickets` |
| POST | `/api/tasks/cron` | `CronApiController::execute` → `Cron::run()` | `can_exec_cron` |
| * | rotte aggiuntive registrate da plugin (segnale `api`) | | |

Il file `web.config`/`.htaccess` di `api/` riscrive `/api/tickets.json` → `http.php/tickets.json`.

### 1.2 Autenticazione
- Header **`X-API-Key: <chiave>`**.
- La chiave deve esistere, essere attiva e avere `ipaddr` **uguale** all'IP del client (dopo risoluzione proxy fidati). Errore → 401 "API key not found/active or source IP not authorized".
- Nessuna sessione persistente (API_SESSION).

### 1.3 Creazione ticket — payload
Campi supportati (validati: chiavi sconosciute → 400 "Unexpected data received in API request"):
`alert` (bool, default true: invia alert agli agenti), `autorespond` (bool, default true), `source` (default `API`), `topicId`, `priorityId`, `ip`, `message`, `attachments[]` (`name`, `type`, `data`, `encoding`, `size`), `system_emails`, `thread_entry_recipients`, + **nomi dei campi** del form Ticket (`subject`, `priority`, custom), del form utente (`email`, `name`, `phone`, `notes`, custom) e dei form del topic indicato; JSON/XML anche `duedate`, `slaId`, `staffId` (assegnazione); email: `header`, `mid`, `emailId`, `to-email-id`, `ticketId`, `reply-to`, `reply-to-name`, `in-reply-to`, `references`, `thread-type`, `mailflags`, `recipients`.
- **JSON**: `message` in formato RFC 2397 (`data:text/html,…` o testo semplice); `attachments` = lista di oggetti `{ "<nomefile>": "data:<mime>;base64,<dati>" }`; `phone` con interno `X`.
- **XML**: elemento radice `<ticket>`; valori come attributi o sotto-elementi; `<message type="text/html">` CDATA; `<attachments><file name type encoding>`.
- **Email**: messaggio MIME completo.
- Gli allegati sono validati con le regole del campo `message` del form ticket (se gli allegati sono disabilitati sul campo, vengono scartati); base64 malformato → errore soft sull'allegato.

### 1.4 Risposte
| Codice | Significato |
|---|---|
| 201 | creato: body = **numero del ticket** (text/plain) |
| 400 | dati non validi / inattesi / body illeggibile |
| 401 | API key mancante/non valida/IP non autorizzato/permesso mancante |
| 403 | ticket rifiutato (filtro, ban list, utente non registrato) |
| 415 | formato non supportato |
| 500 | errore generico ("Unable to create new ticket: …") |
Errori API loggati in `syslog` (senza alert email), con la chiave mascherata.

### 1.5 Cron via HTTP
`POST /api/tasks/cron` con API key `can_exec_cron` → 200 "Completed". Script `setup/scripts/rcron.php` per invocarlo da remoto.

## 2. Ingressi CLI

| Comando | Scopo |
|---|---|
| `php api/cron.php` | cron locale (nessuna API key; solo CLI) |
| `php api/pipe.php < email.eml` | piping MTA locale (nessuna API key) → exit code postfix (0 ok, 75 retry…) |
| `setup/scripts/automail.php` / `automail.pl` | piping remoto: legge l'email da stdin e la invia a `/api/tickets.email` con API key |
| `php manage.php <modulo> …` | tool di amministrazione (doc 12) |

## 3. Rotte AJAX — pannello staff (`/scp/ajax.php/<path>`)

Tutte richiedono agente autenticato (403 "Must login" altrimenti), CSRF per i metodi non-GET (header `X-CSRFToken`), e verificano i permessi nel metodo. Molte rotte GET restituiscono l'HTML di un **dialog**; la POST corrispondente restituisce **201** (successo, il dialog si chiude) oppure di nuovo l'HTML del form con gli errori (200).

### 3.1 Ticket (`ajax.tickets.php:TicketsAjaxAPI`)
| Metodo | Path | Funzione |
|---|---|---|
| GET/POST | `tickets/<tid>/change-user` | cambio proprietario |
| GET/POST | `tickets/<tid>/user` | vista/modifica utente del ticket |
| GET | `tickets/<tid>/preview` | anteprima (hover in coda) |
| GET/POST | `tickets/<tid>/forms/manage` | aggiungi/rimuovi form al ticket |
| GET/POST | `tickets/<tid>/merge`, `tickets/<tid>/link` | dialog e esecuzione merge/link |
| GET | `tickets/<tid>/merge/preview` | anteprima merge |
| GET | `tickets/<tid>/relations` | ticket correlati (merge/link) |
| GET | `tickets/<tid>/canned-resp/<cid>.json|txt` | testo canned con variabili sostituite + allegati |
| GET | `tickets/<tid>/status/<state>[/<sid>]` | dialog cambio stato |
| POST | `tickets/<tid>/status` | esegue cambio stato (+commento) |
| * | `tickets/<tid>/thread/<entry_id>/<action>` | azioni su thread entry (edit, resend, view_headers, create_ticket, create_task…) |
| GET | `tickets/status/<state>[/<sid>]` | dialog cambio stato di massa |
| POST | `tickets/status/<state>` | cambio stato di massa (`tids[]`) |
| GET | `tickets/<tid>/tasks` | lista task del ticket |
| * | `tickets/<tid>/add-task` | crea task legato |
| GET/POST | `tickets/<tid>/tasks/<id>/view`, `tickets/<tid>/tasks/<id>` | vista/azioni task nel contesto del ticket |
| GET | `tickets/lookup?q=` | typeahead ticket (numero/email/oggetto) |
| GET | `tickets/number-lookup` | lookup per numero |
| * | `tickets/mass/<action>[/<what>]` | azioni di massa (assign, claim, transfer, refer, merge, link, delete, reopen, close) |
| * | `tickets/<tid>/transfer` | trasferimento |
| * | `tickets/<tid>/field/<fid|name>/edit` | modifica inline campo |
| * | `tickets/<tid>/field/<fid|name>/view` | visualizza campo |
| * | `tickets/<tid>/assign[/<agents|teams>]` | assegnazione |
| * | `tickets/<tid>/release` | rilascio |
| * | `tickets/<tid>/mark/<answered|unanswered|overdue>` | marcature |
| * | `tickets/<tid>/refer[/<to>]` | referral |
| * | `tickets/<tid>/referrals` | gestione referral |
| * | `tickets/<tid>/claim` | presa in carico |
| * | `tickets/export/<queue_id>`, `tickets/export/adhoc,<key>` | export CSV |
| GET/POST/DELETE | `tickets/search…` | ricerca avanzata: `search` (dialog/esegui), `search/<id>`, `search/adhoc,<key>`, `search/create`, `search/<id>/save`, `search/save`, `DELETE search/<id>`, `search/field/<id>`, `search/column/edit/<id>`, `search/sort/edit/<id>`, `search<id>/delete|disable|enable` |
| POST | `lock/ticket/<tid>` | acquisisci lock (JSON `{id, time, code}` o errore se bloccato da altri) |
| POST | `lock/<id>/ticket/<tid>/renew` | rinnova lock |
| POST | `lock/<id>/release` | rilascia lock |

### 3.2 Task (`ajax.tasks.php:TasksAjaxAPI`)
`tasks/<tid>/preview`, `tasks/<tid>/edit` (GET/POST), `tasks/<tid>/field/<fid|name>/edit`, `tasks/<tid>/transfer`, `tasks/<tid>/assign[/<to>]`, `tasks/<tid>/claim`, `tasks/<tid>/delete`, `tasks/<tid>/close`, `tasks/<tid>/reopen`, `tasks/<tid>/view` (GET), `tasks/<tid>` (POST: risposta/nota), `tasks/<tid>/thread/<id>/<action>`, `tasks/add`, `tasks/<tid>/add`, `tasks/lookup`, `tasks/mass/<action>[/<what>]`.

### 3.3 Thread e collaboratori (`ajax.thread.php`)
`thread/<tid>/collaborators/<manage>/preview`, `thread/<tid>/collaborators/<manage>` (GET), `POST thread/<tid>/collaborators` (aggiorna attivi/elimina), `thread/<tid>/add-collaborator/<type>/<uid>`, `.../auth:<bk>:<id>` (utente da directory esterna), `thread/<tid>/add-collaborator/<type>` (nuovo utente), `thread/<tid>/collaborators/<cid>/view`, `POST thread/<tid>/collaborators/<cid>`.

### 3.4 Utenti (`ajax.users.php`) e organizzazioni (`ajax.orgs.php`)
Utenti: `users` (GET ricerca typeahead `?q=`), `users/local`, `users/remote` (directory esterne), `users/<id>` (GET/POST), `users/<id>/preview`, `users/<id>/edit`, `users/lookup`, `users/lookup/form` (GET/POST crea), `users/add`, `users/import`, `users/select[/<id>]`, `users/select/auth:<bk>:<id>`, `users/<id>/register` (GET/POST), `users/<id>/delete` (GET/POST), `users/<id>/manage[/<target>]` (account: lock, reset, conferma…), `users/<id>/org[/<orgid>]`, `users/staff` (ricerca agenti), `POST users/<id>/note`, `users/<id>/forms/manage`, `users/<id>/tickets/export`.
Organizzazioni: `orgs`, `orgs/search`, `orgs/<id>` (GET/POST), `POST orgs/<id>/profile`, `orgs/<id>/tickets/export`, `orgs/<id>/edit`, `orgs/lookup/form`, `POST orgs/lookup`, `orgs/add` (GET/POST), `orgs/select[/<id>]`, `orgs/<id>/add-user[/<userid>|/auth:<id>]`, `orgs/<id>/import-users`, `orgs/<id>/delete` (GET/DELETE), `POST orgs/<id>/note`, `orgs/<id>/forms/manage`.

### 3.5 Contenuti, configurazione, form, liste
| Path | Funzione |
|---|---|
| `kb/canned-response/<id>.<json|txt>` | testo canned |
| `kb/faq/<id>` | FAQ (inserimento in risposta) |
| `kb/faq/<id>/access` | visibilità FAQ |
| `content/log/<id>` | dettaglio voce syslog |
| `content/context?root=<ctx>` | variabili disponibili per un contesto (autocompletamento `%{`) |
| `content/ticket_variables` | elenco variabili ticket |
| `content/signature/<type>[/<id>]` | firma (mine/dept) per l'editor |
| `content/<id>[/<lang>]/manage`, `content/<name>[/<lang>]/manage`, `POST content/<id>[/<lang>]` | modifica contenuti/pagine (traduzioni) |
| `config/scp`, `config/links`, `config/date-format` | configurazione JS (lingua, lock_time, html_thread, formato data, page_size, path, editor_spacing) |
| `form/help-topic/<id>` | form del topic (apertura ticket) |
| `form/field-config/<id>` (GET/POST) | configurazione campo |
| `DELETE form/answer/<entry>/<field>` | cancella una risposta |
| `POST form/upload/<id>`, `form/upload/<name>`, `form/upload/<ticket|task>/<name>` | upload file (ritorna id) |
| `form/<id>/fields/view` | anteprima form |
| `list/<list>/items[/search]`, `list/<list>/item/<id>/update` (GET/POST), `list/<list>/items/<id>/preview`, `list/<list>/item/add`, `list/<list>/import`, `list/<list>/manage`, `POST list/<list>/delete|disable|enable` | liste custom |
| `filter/action/<type>/config` | form configurazione azione filtro |
| `schedule/add`, `schedule/<id>/clone`, `schedule/<id>/diagnostic` (simula calcolo ore lavorative), `POST schedule/<id>/delete-entries`, `schedule/<id>/entry/add`, `schedule/<sid>/entry/<eid>/update` | orari |
| `plugins/<id>/instances`, `plugins/<id>/instances/<iid>/update`, `plugins/<id>/instances/add`, `POST plugins/<id>/instances/<action>` | istanze plugin |
| `sequence/<id>` (valore corrente), `sequence/manage` (GET/POST) | sequenze |
| `draft/...` | bozze: `POST draft/<id>` aggiorna, `DELETE draft/<id>`, `POST draft/<id>/attach`, `POST draft/<ns>/attach`, `GET draft/<ns>`, `POST draft/<ns>` crea, `GET draft/images/browse` (immagini caricate, per inserimento) |
| `export/<id>/check` | stato export asincrono |
| `note/<id>` (GET/POST/DELETE), `POST note/attach/<ext_id>` | quick notes |
| `POST upgrader` | esecuzione upgrade a step |
| `help/tips/<ns>`, `help/<lang>/tips/<ns>` | help tips (JSON da YAML) |
| `i18n/langs/all`, `i18n/langs`, `i18n/translate/<tag>` (GET/POST), `i18n/<lang>/<tag>` | lingue e traduzioni contenuti |
| `admin/quick-add/department|team|role|staff|queue-column|queue-sort` | creazione rapida da altri form |
| `admin/role/<id>/perms` | permessi di un ruolo |
| `staff/<id>/set-password`, `staff/<id>/change-password`, `staff/<id>/perms`, `staff/reset-permissions`, `staff/change-department`, `staff/<id>/avatar/change`, `staff/<id>/2fa/configure[/<mfid>]`, `staff/<id>/reset-2fa` | gestione agenti |
| `queue/[<id>/]preview`, `queue/<id>`, `queue/addColumn`, `queue/condition/add`, `queue/condition/addProperty`, `queue/counts`, `queue/<id>/delete` | code |
| `POST email/<id>/stash`, `POST email/<id>/auth/config/<type>/delete`, `email/<id>/auth/config/<type>/<auth>` | configurazione account email/OAuth |
| `report/overview/graph|table/groups|table/export|table` | (rotta morta: file `ajax.reports.php` assente) |

## 4. Rotte AJAX — portale cliente (`/ajax.php/<path>`)
| Path | Funzione |
|---|---|
| `config/client` | configurazione JS (cacheable) |
| `draft/<id>` (POST/DELETE), `draft/<id>/attach`, `draft/<ns>/attach`, `GET/POST draft/<ns>` | bozze cliente |
| `form/help-topic/<id>` | form del topic (campi visibili ai clienti) |
| `POST form/upload/<id>`, `form/upload/<name>`, `form/upload/<ticket|task>/<name>` | upload allegati |
| `i18n/<lang>/<tag>` | file lingua JS |
Le rotte cliente richiedono sessione valida dove necessario (403 "Must login").

## 5. App dei plugin
`/scp/apps/dispatcher.php/<path>` e `/apps/dispatcher.php/<path>`: dispatcher vuoti popolati dai plugin (segnali `apps.scp`, `apps.admin`, `ajax.client`). Le voci di menu vengono registrate con `Application::registerStaffApp/registerClientApp/registerAdminApp`.

## 6. Protocollo dialog (frontend staff)
- `$.dialog(url, codes, callback, options)` (scp.js): GET `url` → HTML del form inserito nel popup modale; il `<form action="#tickets/123/assign">` viene inviato in AJAX a `ajax.php/tickets/123/assign` con il metodo del form.
- Se lo **status HTTP** è tra i `codes` attesi (tipicamente **201**) → chiude il popup e invoca `callback(xhr, body)` (body spesso JSON, es. `{id, name}` per un utente creato, oppure messaggio).
- Altrimenti: se il body è JSON con `redirect` → naviga; altrimenti sostituisce il contenuto del popup (form con errori; i tab con errori vengono evidenziati).
- Link con `data-dialog="ajax.php/..."` aprono automaticamente un dialog.
- Anteprime: elementi con `data-preview="#tickets/<id>/preview"` caricano un tooltip HTML.
- PJAX per la navigazione principale (header `X-PJAX`: il server restituisce solo il contenuto + `<title>`).
- Autosalvataggio bozze, lock ticket (acquisizione/rinnovo con timer `lock_time`), refresh automatico code (`auto_refresh_rate`), contatori code (`queue/counts`), autocron (`autocron.php` via `<img>`).

## 7. Formato errori AJAX
`Http::response(<codice>, <messaggio>)`: 400 (dati/URL non supportati), 401 (non autenticato in AjaxController::staffOnly), 403 (permesso negato / "Must login"), 404 (oggetto inesistente), 422 (raro, validazione), 500. Il JS mostra il messaggio in un alert/banner.
