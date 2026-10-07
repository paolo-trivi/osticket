# 05 — Thread, eventi, pipeline email (ingresso/uscita), template, variabili, file e bozze

File: `class.thread.php`, `class.thread_actions.php`, `class.collaborator.php`, `class.email.php`, `class.mail.php`, `class.mailer.php`, `class.mailfetch.php`, `class.mailparse.php`, `class.template.php`, `class.variable.php`, `class.file.php`, `class.attachment.php`, `class.draft.php`, `api.tickets.php`, `api/pipe.php`.

## 1. Thread

### 1.1 Gerarchia classi
- `Thread` (tabella `thread`) → `ObjectThread` → `TicketThread` (object_type `T`/`C`) e `TaskThread` (`A`).
- `ThreadEntry` (tabella `thread_entry`) → `MessageThreadEntry` (`M`), `ResponseThreadEntry` (`R`), `NoteThreadEntry` (`N`).
- `ThreadEvent` (tabella `thread_event`) → sottoclassi per descrizione UI: `AssignmentEvent`, `ReleaseEvent`, `ReferralEvent`, `CloseEvent`, `CollaboratorEvent`, `CreationEvent`, `EditEvent`, `OverdueEvent`, `ReopenEvent`, `ResendEvent`, `TransferEvent`, `ViewEvent`, `MergedEvent`, `LinkedEvent`, `UnlinkEvent`.
- `ThreadReferral`, `Collaborator`, `ThreadEntryEmailInfo` (`thread_entry_email`), `ThreadEntryMergeInfo` (`thread_entry_merge`).

### 1.2 Operazioni sul thread
- `addMessage($vars)`: entry M con `staffId=0`; aggiorna `thread.lastmessage = NOW()`.
- `addResponse($vars)`: entry R con `userId=0`, `pid` = ultimo messaggio; aggiorna `thread.lastresponse`.
- `addNote($vars)`: entry N.
- `getEntries()`: ordinate `created, id`; la vista nasconde le entry con flag HIDDEN (versioni superate). Ordine di visualizzazione configurabile per agente (`thread_view_order` asc/desc).
- Contatori: `getNumMessages/Responses/Notes`, `getNumAttachments`.
- `refer($to)` crea `thread_referral` (Staff `S`, Team `E`, Dept `D`); `isReferred($to)` verifica se un agente (o un suo team/reparto) è tra i referral.
- `addCollaborator($user, $vars)`: crea `thread_collaborator` (flag ACTIVE se `vars.isactive` non 0), evento `collab` `{add: {uid: {name, src}}}` e `object.created`.
- `delete()`: elimina entries, allegati (e file orfani), eventi, collaboratori, referral, indice di ricerca.

### 1.3 Creazione di una entry — `ThreadEntry::create($vars)`
1. Richiede `threadId` e `type`.
2. Corpo: se non è già `ThreadEntryBody`, crea `HtmlThreadEntryBody` (se `enable_richtext`) o `TextThreadEntryBody`. `getClean()` sanitizza (HTML: htmLawed + bilanciamento; testo: escape). Rimuove emoji (`strip_emoticons`, perché DB utf8 3-byte). Corpo vuoto → `-`. Rimuove immagini esterne (`stripExternalImages`, salvo `allow_external_images`).
3. Campi: `created=updated=NOW()`, `type`, `thread_id`, `title` (sanitizzato), `format` (`html`/`text`), `staff_id`, `user_id`, `poster` (stringa), `source`, `flags`.
4. `thread_entry_recipients` (JSON `{to:[...], cc:[...]}`) → `recipients`; flag `REPLY_ALL` se >1 destinatario, altrimenti `REPLY_USER`.
5. Flag automatici: `COLLABORATOR` (autore è collaboratore), `BALANCED` (html), `SYSTEM` (né staff né user).
6. `pid`: esplicito o `reply_to->id`.
7. **Allegati**: unione di `files` (upload web/canned), `attachments` (email/API), immagini inline delle bozze (`cid:<key>` nel body), immagini `data:` base64 estratte dal body. Rimuove allegati inline il cui `cid` è stato tagliato via (quoted reply). Inline solo se immagine "safe" (no SVG). Deduplica per `key`. Riscrive `src="cid:<content-id>"` → `src="cid:<file.key>"`.
8. Body > 65.000 caratteri → salvato come **file allegato** (text/html, inline) e `body=NULL`.
9. Salva, crea `attachment` (type `H`), salva info email (`thread_entry_email`: `mid`, `headers` se `save_email_headers`, `email_id`), `Signal::send('threadentry.created')`.

### 1.4 Modifica di una entry (azione "Edit")
Consentita (non per entry `R` né di sistema) all'autore, al manager del reparto, o a chi ha permesso `thread.edit` nel ruolo. Algoritmo `updateEntry($guard)`:
- Se il nuovo corpo è identico → nulla.
- Crea una **nuova entry** con stessi autore/tipo/thread, `pid = vecchia entry`, nuovo titolo/corpo; sposta gli allegati non inline sulla nuova.
- Se la vecchia era già un edit dello stesso agente e non GUARDED → la elimina e la nuova punta all'originale (evita catene).
- Flag nuova: `EDITED` (eredita gli altri tranne HIDDEN/GUARDED); `GUARDED` se l'edit ha generato un invio email; `editor`/`editor_type='S'`; mantiene `created` originale (stessa posizione nel thread).
- Vecchia entry → flag `HIDDEN`.
- Azione "previous" mostra la versione originale.

### 1.5 Altre azioni su entry (`ThreadEntry::registerAction`)
| id | Gruppo | Descrizione |
|---|---|---|
| `emailrecipients` | E-Mail | mostra destinatari email (To/Cc) |
| `view_headers` | E-Mail | mostra header email originali |
| `edit` | Manage | modifica (vedi sopra) |
| `previous` | Manage | visualizza versione originale |
| `edit_resend` | Manage | modifica una risposta R e la **re-invia** (firma: mine/theirs/dept/none) → evento `resent`, flag `RESENT` |
| `resend` | Manage | re-invia senza modifiche |
| `create_ticket` | Manage | crea un nuovo ticket a partire dall'entry (richiede `ticket.create`): prepopola il form e salva `:form-data` in sessione (vedi doc 04 §2.2 punto 28) |
| `create_task` | Manage | crea un task dall'entry (richiede `task.create`) |
Endpoint: `/scp/ajax.php/tickets/<tid>/thread/<entry_id>/<action>` (GET = dialog, POST = esecuzione; risposta 201 con JSON `{thread_id, new_id, entry(html)}`).

### 1.6 Eventi (timeline/audit)
`$object->logEvent($state, $data, $user, $annul)` → `ThreadEvents::log()`:
- Crea `thread_event` con snapshot (`staff_id` assegnatario o agente corrente se non assegnato, `team_id`, `dept_id`, `topic_id`), `uid`/`uid_type` dell'attore (staff `S`, utente `U`), `username` (username agente, nome/email utente, `SYSTEM`), `event_id` da nome, `data` JSON.
- `$annul`: marca `annulled=1` tutti gli eventi precedenti con quel nome (es. `reopened` annulla `closed`).
- `Ticket::logEvent` emette anche `object.created` (per audit plugin) con `type` = nome evento (eccetto assigned/referred che emettono `object.edited` altrove).
- Rendering: template `{somebody}`, `{timestamp}`, `{assignees}`, `{agent}`, `{dept}`, `{data.<chiave>}`, `{<Classe>data.<chiave>}` (lookup oggetto). In modalità client il nome agente è nascosto se `hide_staff_name`.

Formati `data` per evento:
| Evento | data |
|---|---|
| created | — |
| assigned | `{staff:[id,nome]}` / `{team:id}` / `{claim:true}` |
| released | `{staff:id?, team:id?}` |
| referred | `{staff:[id,nome]}` / `{team:id}` / `{dept:id}` |
| transferred | `{dept: nome}` |
| closed | `{status:[id, nome]}` |
| reopened | — |
| edited | `{status:id}` / `{fields:{field_id:[old,new]}, topic_id:[o,n], sla_id:[o,n], duedate:[o,n], source:[o,n], user_id:[o,n]}` / `{owner:id, fields:{'Ticket Owner':nome}}` / da filtro `{value, filter, type}` |
| collab | `{add:{uid:{name,src}}}` / `{del:[nomi]}` / `{org:id}` |
| overdue | — |
| resent | `{entry: id}` |
| merged / linked / unlinked | `{ticket:'Ticket #N', id}` |
| deleted, viewed, message, note, login, logout, error | vari |

## 2. Pipeline EMAIL IN INGRESSO

### 2.1 Canali
1. **Fetch IMAP/POP** (cron): `osTicket\Mail\Fetcher::run()`.
2. **Piping MTA**: `php api/pipe.php < email` (o `setup/scripts/automail.php`/`.pl` che fanno POST HTTP) → `PipeApiController::process('cli')` (exit code postfix-style: 0 ok, 66 dati, 77 permesso, 65 formato, 69 non disponibile, 75 temporaneo).
3. **API HTTP**: `POST /api/tickets.email` con API key (`can_create_tickets`) e corpo = email grezza RFC822.

### 2.2 Fetcher
1. Esegue solo se `enable_mail_polling=1`.
2. Seleziona `email_account` di tipo mailbox con `active=1`, (`num_errors ≤ 5` **oppure** `last_error` più vecchio di 10 min) e (`last_activity` NULL o più vecchio di `fetchfreq` minuti), ordinate per `last_activity`.
3. Si ferma all'80% di `max_execution_time` (default 300 s).
4. Per ogni mailbox: connessione (Laminas IMAP/POP3, SSL/TLS, auth basic o XOAUTH2 con token OAuth2 rinnovato automaticamente), cartella `folder` (default INBOX).
5. Seleziona i messaggi: se il numero supera `fetchmax` (default 30) prende gli **ultimi** N, altrimenti i primi N.
6. Per ogni messaggio: `TicketApiController('cli')->processEmail(rawEmail, ['emailId' => mailbox.email_id])`. Esito positivo (anche ticket rifiutato da filtro = `TicketDenied`) → marca come letto, poi **sposta** in `archivefolder` (se impostata) oppure **cancella** (se `postfetch=delete`), altrimenti lascia. Errori conteggiati.
7. `expunge`, aggiornamento `last_activity`, `num_errors`/`last_error`/`last_error_msg`. Dopo 5 errori consecutivi: alert admin "Mail Fetch Failure Alert" e retry ritardato di 10 min.

### 2.3 Parsing (`EmailDataParser` → `Mail_Parse`)
Produce un array `$data`:
| Chiave | Contenuto |
|---|---|
| `subject` | oggetto decodificato (o `[No Subject]`) |
| `header` | header grezzi |
| `mid` | Message-ID |
| `in-reply-to`, `references` | header di threading |
| `email`, `name` | primo indirizzo From valido (nome = email se assente) |
| `reply-to`, `reply-to-name` | |
| `recipients[]` | `{source:'Email (to|cc)', name, email}` per indirizzi **non** di sistema in To/Cc (Delivered-To marcati `delivered-to`) |
| `thread_entry_recipients` | `{to:[...], cc:[...]}` stringhe "Nome <email>" (include le email di sistema in `to`) |
| `system_emails[]` | id delle email di sistema trovate in To/Cc/Bcc/Delivered-To |
| `emailId`, `to-email-id` | prima email di sistema destinataria (fallback: mailbox del fetch o `default_email_id`) |
| `priorityId` | da header `X-Priority`/`Importance`/`Priority` (1 alta…), usato solo se `use_email_priority=1` |
| `mailflags.bounce` | `TicketFilter::isBounce(headers)` o DSN |
| `message` | corpo: HTML (se rich text abilitato e presente) altrimenti testo; con `strip_quoted_reply=1` taglia tutto dopo il separatore `reply_separator` (default `-- reply above this line --`) |
| `attachments[]` | `{name, type, data, cid, ...}` (gestione TNEF winmail.dat, message/rfc822) |
| `source` | `Email` |

Bounce/DSN: il corpo diventa il report di consegna, `thread-type=N` (nota), References recuperate dal messaggio originale.
Errore di parsing: se gli header sono leggibili crea comunque un messaggio di testo con l'errore e allega l'email grezza (.eml).

Rilevamento auto-reply (`TicketFilter::isAutoReply`): header `Auto-Submitted: auto-replied|auto-generated`, `Precedence/X-Precedence: auto_reply|bulk|junk|list`, `X-Autoreply: yes`, `X-Auto-Response-Suppress: AutoReply`, `X-Autoresponse`, `X-AutoReply-From`, `X-Autorespond`, `X-Mail-Autoreply`, `X-Autogenerated: Reply`, `X-AMAZON-MAIL-RELAY-TYPE: notification`.
Rilevamento bounce: From contiene `MAILER-DAEMON`/`<>`/`postmaster@`, Subject inizia con "DELIVERY FAILURE", "DELIVERY STATUS", "UNDELIVERABLE:", "Undelivered Mail Returned", `Return-Path: <>`, `Content-Type` con `report-type=delivery-status`, `X-Failed-Recipients`.

### 2.4 Instradamento: nuovo ticket o risposta? (`TicketApiController::processEmail`)
```
1. entry = ThreadEntry::lookupByEmailHeaders($data, $seen)
   1a. se esiste un thread_entry_email con mid == data.mid → $seen=true (già processata) → ritorna quell'entry
   1b. per ogni Message-ID in mid / in-reply-to / references (references da destra a sinistra)
       + eventuale "Ref-Mid: <id>" o class="mid-<id>" incorporato nel corpo:
         decodeMessageId(mid) → se è un ID generato da QUESTO sistema (loopback, firma HMAC valida):
            entry = ThreadEntry(entryId) appartenente a threadId → imposta userId/staffId/userClass
            (riallinea userId/staffId all'effettivo mittente se l'email corrisponde ad altro utente/agente)
   1c. "passive threading": qualsiasi entry il cui mid compare tra quelli referenziati → mailinfo.passive=true (niente auto-risposta)
   1d. ultima risorsa: oggetto contiene "#<numero>" di un ticket esistente E il mittente è owner o collaboratore → ultimo messaggio
   se entry trovata → entry->postEmail($data):
       - se l'entry ha già quel mid → ok (duplicato)
       - se il mid in arrivo è stato generato da questo sistema (loop) → log errore "Email loop detected", ignora
       - altrimenti thread->postEmail($data, entry)
2. altrimenti Thread::lookupByEmailHeaders($data) (Message-ID generati per thread senza entry) → thread->postEmail()
3. altrimenti Ticket::create($data, 'Email') (via createTicket(source='Email'))
   - se rifiutato (403) e c'è mid → registra una thread_entry_email con entry 0 e quel mid (non riprocessare) e lancia TicketDenied
```

### 2.5 `Thread::postEmail($mailinfo, $entry)` (continuazione via email)
- Se il ticket è chiuso e **non** riapribile e il mittente non è un agente → scartata.
- Determina il tipo di post:
  | Mittente | Tipo entry |
  |---|---|
  | owner (userClass `U`) | M (messaggio) |
  | collaboratore (`C`) | M con flag COLLABORATOR |
  | agente/admin (`S`/`A`, riconosciuto dal Message-ID) | **N (nota interna)** — una risposta email di un agente NON diventa una risposta al cliente |
  | non identificato ma email = owner | M |
  | non identificato ma email = collaboratore | M (COLLABORATOR) |
  | email di sistema | scartata (loop) |
  | sconosciuto | M con banner "Received From: Nome <email>" anteposto al corpo, user 0 |
- Se il mittente è un utente esistente diverso da owner/agente assegnato e collaboratore in CC → M.
- `system_emails` → `systemReferral`.
- Post: `ticket->postThreadEntry('M'|'N', $vars)` → `postMessage`/`postNote` (con riapertura, auto-risposte, alert). Se il thread è un child (`C`) l'entry viene spostata nel parent.
- `autorespond = !passive`.

### 2.6 Formato Message-ID generato (`Mailer::getMessageId`) — fondamentale per il threading
```
<B{sysid}-{rand5}-{base64(tag)}-{email_di_sistema}>
sysid = primi 6 char di base64(md5('mail'.SECRET_SALT)) con '+'→'='
tag   = pack('VVVa', user_id_destinatario, thread_entry_id, thread_id, userClass) . firma
userClass: S staff, U owner, C collaboratore, M mailing list, ? sconosciuto
firma = ultimi 5 byte di HMAC-SHA1(tag13 . rand . sysid, SECRET_SALT)
```
Decodifica: verifica versione `B` (supportata anche `A` legacy), firma HMAC, e `loopback` = sysid uguale al sistema corrente. Permette di identificare destinatario, entry e thread di una risposta anche se il client email modifica l'oggetto. In più il corpo HTML incorpora `<div style="display:none" class="mid-<MessageID>">` + `reply_separator`, e il corpo testo termina con `Ref-Mid: <MessageID>`.

## 3. Pipeline EMAIL IN USCITA

### 3.1 API
- `Email::send($to, $subject, $body, $attachments, $options)`, `sendAutoReply` (opzione `autoreply`), `sendAlert` (opzione `notice`).
- `osTicket\Mail\Mailer` (wrapper Laminas): costruttore seleziona gli **account SMTP** da provare: SMTP dell'email mittente (se attivo) + **default MTA** (`default_smtp_id`); se nessuna email → default MTA o email di default.
- `Mailer::sendmail()` statico: fallback con PHP `mail()` quando non c'è DB.

### 3.2 `Mailer::send($recipients, $subject, $body, $options)`
1. Message-ID custom (sopra), From = email/nome (opz. `from_name`), Subject su una riga.
2. Header: `X-Mailer: osTicket Mailer`; `autoreply` → `Precedence: auto_reply`, `X-Autoreply: yes`, `X-Auto-Response-Suppress: DR, RN, OOF, AutoReply`, `Auto-Submitted: auto-replied`; `notice` → `X-Auto-Response-Suppress: OOF, AutoReply`, `Auto-Submitted: auto-generated`; `bulk` → `Precedence: bulk`; `nobounce` → `Return-Path: <>` (altrimenti Return-Path = email mittente).
3. Threading: se `options.thread` è una ThreadEntry, imposta `In-Reply-To`/`References` all'ultimo messaggio email del destinatario nel thread (owner/collaboratore o qualsiasi per mailing list); aggiunge `reply-tag` (separatore) se `strip_quoted_reply`.
4. Destinatari: `MailingList` di `EmailRecipient` (to/cc/bcc), `TicketOwner`/`Staff`/`EmailAddress` → To, `Collaborator` → Cc, stringhe → To.
5. Corpo: HTML con div nascosto `mid-…` + reply-tag; versione testo generata con `html2text` (90 colonne) + `Ref-Mid:`. Se rich text: le immagini `cid:<key32>` vengono incorporate come inline (Content-ID `<key>@dominio`). Allegati aggiunti (file o `Attachment`).
6. Invio: prova ogni account SMTP; se l'account **non consente spoofing** e il From differisce dall'account → imposta `Sender` = account SMTP (mantiene il nome). Errore → log "Unable to email via SMTP" e prova il successivo. Infine fallback `Sendmail` (PHP mail()). Ritorna il Message-ID o false.
7. Errori di invio loggati come warning/error **senza alert email** (anti-loop).

### 3.3 Account SMTP / Mailbox (`email_account`)
- Credenziali in `config` namespace `email.<eid>.account.<aid>` (cifrate con `Crypto`), `auth_id` = riferimento.
- OAuth2: provider registrati da plugin (`Oauth2AuthorizationBackend`); flusso di autorizzazione da admin (`/scp/ajax.php/email/<id>/auth/config/<type>/<auth>`), token di accesso/refresh salvati cifrati; opzione "strict matching" (l'email del resource owner deve coincidere).
- `allow_spoofing` (SMTP), `host`, `port`, `protocol`, `encryption`, `folder`, `archivefolder`, `postfetch`, `fetchfreq`, `fetchmax`.
- Pagina diagnostica `scp/emailtest.php`: invio di prova.

## 4. Template email

### 4.1 Struttura
- `email_template_group` (set, con lingua) + `email_template` (code_name, subject, body HTML).
- Template disponibili (raggruppati):
  - **a.ticket.user** (verso l'utente): `ticket.autoresp`, `ticket.autoreply`, `message.autoresp`, `ticket.notice`, `ticket.overlimit`, `ticket.reply`, `ticket.activity.notice`.
  - **b.ticket.staff** (verso agenti): `ticket.alert`, `message.alert`, `note.alert`, `assigned.alert`, `transfer.alert`, `ticket.overdue`.
  - **c.task**: `task.alert`, `task.activity.notice`, `task.activity.alert`, `task.assignment.alert`, `task.transfer.alert`, `task.overdue.alert`.
- Ogni template ha un **contesto** di variabili (es. `ticket.reply`: `ticket`, `signature`, `response`, `staff`, `poster`, `recipient`; alert: `ticket`, `recipient` (Staff), `comments`, `assignee`, `assigner`, `message`, `note`, `activity`).
- Se il gruppo non contiene un code_name, si usa il default della lingua dal YAML (`include/i18n/<lang>/templates/email/<code>.yaml`).
- Il gruppo usato è quello del reparto del ticket (`department.tpl_id`), altrimenti `default_template_id`.
- Admin: `scp/templates.php` (clona gruppo, modifica template con anteprima variabili, abilita/disabilita).

### 4.2 Contenuti "pagina" usati come email
`content` di tipo `registration-staff`, `pwreset-staff`, `registration-client`, `pwreset-client`, `registration-confirm`, `registration-thanks`, `access-link`, `email2fa-staff` (vedi doc 02 §2.10), con contesti: `recipient`, `link`, `user`, `staff`, `ticket`, `code`.

## 5. Motore delle variabili (`VariableReplacer`)

- Sintassi: `%{oggetto.proprietà.sotto}` (anche URL-encoded `%%7B…%7D`).
- Risoluzione di ogni segmento su un oggetto: (1) chiave array, (2) `$obj->getVar($tag)`, (3) proprietà pubblica, (4) metodo `get<Tag>()`. Un oggetto finale viene convertito con `asVar()` o `__toString()`.
- **Blacklist**: `passwd`, `password`, `authkey` → stringa vuota.
- Variabili globali sempre assegnate: `url` (base URL helpdesk), `company` (form Company: `name`, `website`, `phone`, `address`).
- Scope documentati via `getVarScope()` (usati per l'autocompletamento nell'editor admin `/scp/ajax.php/content/context`).
- Oggetti principali e variabili: `ticket.*` (doc 04 §17), `recipient.*` (`name`, `email`, `ticket_link` per utenti), `staff.*` (`name`, `email`, `phone`, `mobile`, `signature`, `dept`…), `dept.*` (`name`, `manager`, `signature`, `members`…), `team.*`, `topic.*`, `user.*` (`name`, `email`, `phone`, `organization`, campi form), `org.*`, `message`/`response`/`note` (ThreadEntry: `body`, `title`, `poster`, `create_date`, `files`…), `thread.*` (`original`, `lastmessage`, `complete` = thread completo renderizzato), `signature`, `comments`, `assignee`, `assigner`, `activity` (`title`, `description`), `link`, `code`.
- Date (`FormattedDate`): `.long`, `.short`, `.full`, `.time`, `.date`, `.humanize`, default = datetime formattato.
- Nomi (`PersonsName`): `.first`, `.last`, `.full`, `.short`, `.shortformal`, `.legal`, `.lastfirst`, `.original`, `.initials`, default secondo `agent_name_format`/`client_name_format`.
- Variabili che portano **allegati** (es. `%{message}` con file) restituiscono `TextWithExtras`: il Mailer allega automaticamente i file.

## 6. File e allegati

### 6.1 Storage
- `file` (metadati) + backend: `D` database a chunk da 500 KB in `file_chunk`; altri backend via plugin (`FileStorageBackend::register`). Backend di default configurabile (`default_storage_bk`, default `D`); se il backend scelto fallisce si ripiega sul DB.
- `key` = 5 char da sha1(microtime) + sha1(contenuto) base64url (≈32 char) — usata in URL e nei `cid:`.
- `signature` = 16 char sha1 + 16 char md5 base64url del contenuto → **deduplicazione** (stessa firma + stessa size → riuso del file esistente).
- MIME type da `fileinfo` se mancante.
- `ft`: `T` attachment, `L` logo, `B` backdrop.

### 6.2 Upload
- Campo `FileUploadField` (form dinamici, risposta, nota): upload AJAX (`/ajax.php/form/upload/<field_id>` o `/upload/<name>` → `attach`) che restituisce l'id del file; il form invia poi gli id. Validazione: dimensione massima (`max_file_size` o config campo), estensioni/MIME consentiti (config campo: `extensions`, `mimetypes`, `size`, `max`), numero massimo file.
- Configurazione allegati client sul campo `message` del form ticket ("Issue Details": allow attachments, max size, types). L'API usa le stesse regole.
- Immagini inline dell'editor: `/ajax.php/draft/<id|namespace>/attach` (salvate come allegati della bozza, poi riassegnate all'entry).

### 6.3 Download
URL firmato: `file.php?key=<key>&expires=<ts>&signature=<hmac>[&id=<attachment_id>][&disposition=inline|attachment][&s=<size>]`.
- `expires` = mezzanotte successiva ad almeno 12 h da ora.
- `signature = HMAC-SHA1("Host=<host>\nPath=<ROOT_PATH>\nId=<id>\nKey=<key>\nHash=<file.signature>\nExpires=<exp>", SECRET_SALT)`.
- Se `files_req_auth=1` serve una sessione (utente o agente), eccetto allegati di FAQ (`F`) e pagine (`P`).
- `disposition=inline` solo per immagini sicure (no SVG); preferenza agente `img_att_view`. `s=<size>` restituisce una miniatura ridimensionata.
- I body HTML salvati contengono `cid:<key>`; al rendering `Format::viewableImages()` li sostituisce con URL firmati (`data-image="<key>"`).

### 6.4 Pulizia
Cron: file `ft='T'` senza `attachment` creati da >1 giorno → eliminati (dati inclusi).

## 7. Bozze (`draft`)
- Autosalvataggio dell'editor Redactor ogni pochi secondi (`/ajax.php/draft/<namespace>` POST crea, `/draft/<id>` POST aggiorna, DELETE elimina; lato cliente endpoint `*Client`).
- Namespace: `ticket.response.<tid>`, `ticket.note.<tid>`, `ticket.staff` (nuovo ticket da agente), `ticket.client` (nuovo ticket da portale), `task.response.<id>`, `task.note.<id>`, `canned`, `faq`, `page`, `tpl.<code>`, `signature`, `settings.alerts`, `org`… (+ `.<id>` dell'oggetto).
- `staff_id` = id agente, oppure **id utente** per i clienti, oppure `1<<31` per anonimi.
- HTML sanitizzato; immagini inline come allegati `D`.
- Cancellate: dopo l'invio della risposta/nota, alla chiusura del ticket (`ticket.%.<id>`), dal cron dopo 14 giorni di inattività.
