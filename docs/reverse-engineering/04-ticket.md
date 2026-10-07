# 04 — Dominio TICKET: ciclo di vita completo

File principali: `include/class.ticket.php` (classe `Ticket`, ~4850 righe), `class.filter.php`, `class.filter_action.php`, `class.banlist.php`, `class.sla.php`, `class.schedule.php`, `class.businesshours.php`, `class.lock.php`, `class.collaborator.php`, `scp/tickets.php`, `include/ajax.tickets.php`, `tickets.php`/`open.php`/`view.php` (cliente).

## 1. Modello

Un ticket è composto da:
1. Riga `ticket` (metadati di workflow).
2. **Form "Ticket Details"** (form tipo `T`, unico): campi `subject` (id 20), `message` (21, tipo `thread` = corpo del primo messaggio, non salvato come risposta), `priority` (22) + eventuali campi custom aggiunti dall'admin. Valori in `form_entry`/`form_entry_values`, materializzati in `ticket__cdata`.
3. **Form aggiuntivi** (tipo `G`) collegati all'help topic scelto → altre `form_entry` con `object_type='T'`.
4. **Thread** (`thread.object_type='T'`) con entries M/R/N, eventi, collaboratori, referral.
5. **Utente proprietario** (`user`) ed eventuali collaboratori.

Accesso ai valori del form: `$ticket->getAnswer('subject')`, `$ticket->getSubject()`, `getPriority()` (oggetto `Priority` dal campo priority; fallback `default_priority_id`).

### Sorgenti (`ticket.source`)
`Web` (portale cliente), `Email` (fetch/pipe), `Phone`, `API`, `Other`. Lo staff che apre un ticket sceglie la sorgente (default Phone/Other). Mapping "origin → target filtri": web/phone/staff → `Web`, email → `Email`, api → `API`.

### Stati
Tabella `ticket_status` con `state` ∈ {`open`, `closed`, `archived`, `deleted`}. Gli stati sono personalizzabili (nome, stato logico, proprietà `allowreopen` + `reopenstatus`). La logica usa sempre `state`, non il nome:
- `isOpen()` ⇔ state=open; `isClosed()` ⇔ state=closed.
- `archived`: non visibile nelle code né al cliente (solo ricerca admin) — vedi visibilità.
- `deleted`: impostarlo = **cancellazione fisica** se l'agente ha `ticket.delete` (non esiste soft-delete).

### Flag booleani
- `isanswered`: 1 dopo una risposta agente (`onResponse`), 0 dopo un messaggio cliente (`onMessage`) o una canned auto-reply. Code "Open" vs "Answered".
- `isoverdue`: 1 quando superata la scadenza (cron) o marcato manualmente dal manager del reparto.

## 2. Creazione ticket — `Ticket::create($vars, &$errors, $origin, $autorespond=true, $alertstaff=true)`

È "la madre di tutte le funzioni". Chiamata da: portale web (`open.php`, origin `web`), staff (`Ticket::open`, origin `staff`), API (`api`), email (`email`).

### 2.1 Input `$vars` riconosciuti
`email`, `name`, `phone`, (campi form utente per nome), `subject`, `message` (ThreadEntryBody), campi form ticket per nome, `topicId`, `deptId`, `priorityId`, `slaId`, `staffId`, `teamId`, `assignId` (staff: `s<id>`/`t<id>`), `statusId`, `duedate`, `source`, `ip`, `uid` (utente esistente), `ccs` (array user id collaboratori), `emailId`, `to-email-id`, `mid`/`header`/`references`/`in-reply-to` (email), `recipients` (destinatari email per auto-collaboratori), `mailflags` (`bounce`, `auto-reply`, `spam`, `viral`), `autorespond`, `cannedResponseId`, `system_emails`, `files`/`attachments`, `note` (staff), `thread_entry_recipients`.

### 2.2 Algoritmo (ordine esatto)

1. `Signal::send('ticket.create.before', null, $vars)`.
2. Istanzia nuovo `TicketForm` (form T) con `$vars` come sorgente. Per origin ≠ web/staff copia i valori grezzi dai `$vars` ai campi (parse).
3. Se `uid` → carica `User`.
4. **Validazione per origin**:
   - `web`: `topicId` obbligatorio.
   - `staff`: `topicId` obbligatorio, `deptId` int, `duedate` data; + `source` obbligatoria.
   - `api`: `source` obbligatoria.
   - `email`: `emailId` obbligatorio.
   - altro → errore "Invalid ticket origin".
   - `duedate` deve essere parsabile e **futura**.
5. Se nessun errore:
   - Per il topic selezionato: carica i form del topic; per ogni campo disabilitato dal topic lo disabilita; il form T del topic viene sostituito dal form principale (con i campi disabilitati); gli altri form vengono istanziati (`instanciate`) con sorgente `$vars`; `extra = {"disable":[ids]}`.
   - **Filtri pre-creazione**: `filterTicketData($origin, $vars, forms, $user, false)` (vedi §3). Se un filtro rifiuta → `errors = {errno:403, err:"This help desk is for use by authorized users only"}`, log warning "Ticket denied", return 0.
   - **Limite ticket aperti** (`max_open_tickets` > 0, origin ≠ staff): se l'utente (per email) ha già ≥ N ticket aperti → errore "You've reached the maximum open tickets allowed", log warning, return 0.
   - Risoluzione utente: `uid` → oppure `User::lookupByEmail($vars['email'])`. Se non esiste:
     - origin `email` e `accept_unregistered_email=0` → rifiuto, **a meno che** il dominio dell'email appartenga ad un'organizzazione (`Organization::forDomain`).
     - Valida il form utente (tipo U) con i `$vars` (per web solo campi visibili all'utente; per staff solo campi visibili allo staff; per email nessuna validazione) e crea l'utente con `User::fromVars()` (se lo staff ha `user.create`, altrimenti errore "You do not have permission to create users").
6. Valida il form ticket (filtro campi per origin: email → nessuna validazione; staff → campi visibili allo staff; web → campi visibili all'utente).
7. Valida i form del topic (se topic esiste ed è attivo; altrimenti `topicId=0`).
8. Errori → return 0.
9. `Signal::send('ticket.create.validated', null, $vars)`.
10. `autorespond` può essere sovrascritto da `$vars['autorespond']` (es. filtro `noresp`).
11. Se `priorityId` (da filtro/API) → imposta la risposta `priority`.
12. **Impostazioni da email di sistema** (`emailId`): `deptId ?: email.dept_id` (se il reparto non è attivo → reparto default); priorità da email se non impostata; `autorespond &= !email.noautoresp`; topic dall'email se attivo e non già scelto; `source='Email'`.
13. Topic default di sistema (`default_help_topic`) se nessun topic.
14. **Mapping dal topic**: `deptId ?: topic.dept_id`; `statusId ?: topic.status_id`; priorità del topic se non impostata; `autorespond &= !topic.noautoresp`; auto-assegnazione: se non specificato `staffId` e il topic ha `staff_id` → agente, altrimenti se ha `team_id` → team; SLA: `slaId=0` viene ignorato; se `slaId` presente (da filtro) → `slaId ?: default_sla_id`, altrimenti SLA del topic.
15. **Account manager dell'organizzazione**: se l'org dell'utente ha `ASSIGN_AGENT_MANAGER` e un manager `s<id>`/`t<id>` → `staffId`/`teamId` se non già impostati.
16. Default finali: priorità `default_priority_id`, reparto `default_dept_id`, stato `default_ticket_status_id`, `ip = vars.ip ?: REMOTE_ADDR`, `source ?: 'Web'`.
17. **Numero**: `topic->getNewTicketNumber()` (se topic con CUSTOM_NUMBERS: sua sequenza+formato, altrimenti) `cfg->getNewTicketNumber()` (sequenza `ticket_sequence_id`, formato `ticket_number_format`; sequenza 0 → numeri casuali). Il numero è garantito univoco rigenerando finché libero.
18. INSERT `ticket` (`created=lastupdate=NOW()`, number, user, dept, topic, ip, source, email_id se da email; `duedate` solo se origin staff/api, convertita in fuso DB).
19. Crea `thread` (`TicketThread::create`, object_type T).
20. Salva il form ticket: se `subject` vuoto e c'è un topic → subject = nome completo del topic. Salva i form del topic.
21. Ricarica i dati dinamici.
22. `logEvent('created', null, staff ?: user)`.
23. Imposta stato default temporaneo se mancante.
24. **Collaboratori**: `vars.ccs` → `addCollaborators`; se org con `COLLAB_ALL_MEMBERS` o `COLLAB_PRIMARY_CONTACT` → aggiunge membri/contatti primari (attivi) e `logEvent('collab', {org})`.
25. **Posta il primo messaggio**: `vars.title = subject`, `userId = owner` → `postMessage($vars, $origin, alerts=false)`.
26. **Filtri post-creazione**: `filterTicketData(..., $ticket)` → esegue solo le azioni `email` (Send an Email) e registra eventi "edited by filter" per le azioni applicate.
27. Marca il messaggio come `FLAG_ORIGINAL_MESSAGE`.
28. Se il ticket è creato "da un thread entry" di un altro ticket/task (sessione `:form-data` con `ticketId`/`taskId`/`eid`): nota interna su entrambi con link incrociati.
29. **SLA**: `selectSLAId($vars['slaId'])` → priorità: (1) slaId esplicito (filtro/API), (2) SLA del reparto, (3) SLA del topic, (4) `default_sla_id`.
30. **Stato**: `setStatus(statusId)`; se fallisce → stato default.
31. **Assegnazione** (solo se stato `open`): se `assignId` (staff) → `assign()` con form; altrimenti auto-assegnazione `assignToStaff(staffId)` e/o `assignToTeam(teamId)` (con autore "Ticket Filter"; niente alert al team se assegnato anche ad un agente).
32. `updateEstDueDate()` (calcola `est_duedate` da SLA).
33. **Controlli auto-risposta**: disabilitata se l'email del mittente è un'email di sistema (anti-loop), se `mailflags.bounce`, se il messaggio è un auto-reply.
34. **Canned auto-response** (`cannedResponseId` da filtro): `postCannedReply()`; se OK il ticket resta "unanswered" e l'auto-risposta standard viene soppressa.
35. `system_emails` (altre email di sistema in To/Cc) → `systemReferral()`: referral al reparto di ciascuna email (escluse quelle già coinvolte in trasferimenti e quella del ticket).
36. Reparto con `ticket_auto_response=0` → niente auto-risposta.
37. Messaggio bounce → niente alert staff.
38. `onNewTicket($message, $autorespond, $alertstaff)` → notifiche (§10).
39. Se l'utente ha **appena raggiunto** `max_open_tickets` → `onOpenLimit()` (log + notice `ticket.overlimit` all'utente se `overlimit_notice_active` + alert admin).
40. `Signal::send('ticket.created', $ticket)`.

### 2.3 `Ticket::open($vars, &$errors)` (apertura da staff)
- Richiede `$thisstaff`; se `deptId` e il ruolo dell'agente in quel reparto non ha `ticket.create` → errore.
- `source` deve essere valida. Se non c'è `uid`: email valida e nome obbligatori.
- `assignId` richiede `ticket.assign` nel reparto (o globale).
- Pulisce `response` e `note`; prende `message` e allegati dal campo `message` del form ticket.
- `create(..., 'staff', autorespond=false)`.
- Se `response` presente e permesso `ticket.reply` → `postReply()` (alert solo se `reply-to ≠ none` e `ticket_notice_active` disattivato).
- Se non assegnato e c'è `note` → nota interna "New Ticket".
- Se `ticket_notice_active` e `reply-to ≠ none`: invia template **`ticket.notice`** ("New Ticket Notice") ai destinatari (`reply-to` = `all`|`user`|`collabs`…) con firma (mine/dept), allegati del messaggio e della risposta.
- Il controller poi: rigenera l'ID di sessione, cancella bozze `ticket.staff%`, redirect alla vista.

### 2.4 Portale cliente (`open.php`)
- Se `clients_only` (login obbligatorio) e non loggato → login.
- Form: selezione help topic (pubblici e attivi, ordinati secondo `help_topic_sort_mode` a=alfabetico, m=manuale), poi form utente (se guest), form ticket e form del topic caricati via AJAX (`/ajax.php/form/help-topic/<id>`).
- Captcha (se `enable_captcha` e guest).
- `Ticket::create($vars, $errors, 'Web')`; poi pagina "thank-you" (pagina del topic `page_id` o pagina di sistema `thank-you_page_id`) con variabili del ticket. Se l'utente non è loggato la sessione può essere autenticata col token del ticket ("view ticket" link).

## 3. Filtri sui ticket in ingresso (`filterTicketData` + `TicketFilter`)

### 3.1 Dati sottoposti al filtro
- Rimuove eventuali chiavi `field.*` da `$vars`, poi aggiunge `getFilterData()` di ogni form: `field.<id>` = valore testuale (e `field.<id>.<subid>` per sottocampi). Esempio: `field.20` = subject.
- Dati utente: se l'utente esiste → `field.<id>` del form utente + `email` + `name`, + dati organizzazione; altrimenti dati del form utente compilato + organizzazione per dominio email.
- `TicketFilter` costruisce `$this->vars` con: `body` = message, i campi supportati (`name`, `email`, `reply-to`, `reply-to-name`, `topicId`, tutti i `field.*`), sempre `emailId`, e `addressee` = concatenazione nome+email di tutti i `recipients`.

### 3.2 Banlist
Prima dei filtri: se l'email è nella **SYSTEM BAN LIST** (filtro speciale, regole `email equal <addr>`, attive) → `RejectedException`.

### 3.3 Selezione ed esecuzione
1. Filtri attivi con `target IN ('Any', <target dell'origin>)`; se c'è `emailId`, solo filtri con `email_id IN (0, emailId)`; ordinati per `execorder` ASC.
2. `Filter::matches($vars)`: se il filtro ha `email_id` e target Email deve coincidere con `emailId`. Per ogni regola (attiva):
   | how | test |
   |---|---|
   | equal | `strcasecmp(v, val) == 0` (case-insensitive) |
   | not_equal | `strcasecmp != 0` |
   | contains | `stripos !== false` |
   | dn_contain | `stripos === false` |
   | starts | `stripos === 0` |
   | ends | `iEndsWith` |
   | match | `preg_match(val, v)` (regex con delimitatori forniti dall'utente) |
   | not_match | nessun match |
   `match_all_rules=1` → AND (prima regola falsa = no match); `0` → OR (prima vera = match).
3. Per ogni filtro corrispondente: `apply()` delle azioni in ordine `sort`. Pre-creazione si eseguono tutte le azioni **tranne** `email`; post-creazione **solo** `email`. Se `stop_onmatch` → stop.
4. Azioni (modificano `$vars`):
   | type | Effetto |
   |---|---|
   | `reject` | `RejectedException` → ticket rifiutato (403) |
   | `replyto` | se c'è Reply-To diverso dal From: `email=reply-to`, `name=reply-to-name` → `FilterDataChanged` → **ri-esecuzione completa** dei filtri con i nuovi dati |
   | `noresp` | `autorespond=false` |
   | `canned` | `cannedResponseId = canned_id` (risposta automatica) |
   | `dept` | `deptId` (solo se reparto attivo) |
   | `pri` | `priorityId` |
   | `sla` | `slaId` |
   | `team` | `teamId` |
   | `agent` | `staffId` |
   | `topic` | `topicId` (solo se attivo) |
   | `status` | `statusId` (stati open/closed abilitati) |
   | `email` | (post-creazione) invia email: destinatari CSV con placeholder `%{user}`, oggetto e corpo con variabili `%{ticket.*}`, `%{recipient}`, mittente = email di sistema scelta o mailer di sistema |
5. Dopo la creazione, per ogni azione con `getEventDescription` viene registrato un evento `edited` con `{value, filter, type}` (es. "Department set to X by filter Y").

### 3.4 Manutenzione filtri
Quando un reparto/topic viene disattivato o eliminato, `Filter::disableFilters($object)` marca i filtri che lo usano con flag `INACTIVE_DEPT`/`INACTIVE_HT`/`DELETED_OBJECT` (mostrati in admin come warning).

## 4. Accesso e visibilità

### 4.1 Agente → ticket singolo: `checkStaffPerm($staff, $perm=null)`
1. Accesso "di vista" se **almeno uno**:
   - l'agente può accedere al reparto del ticket (`canAccessDept`: reparto primario o esteso, e non `assigned_only`),
   - il ticket è assegnato a lui o ad un suo team (`isAssigned($staff)`, solo se ticket aperto),
   - il thread è "referred" a lui, ad un suo team o ad un suo reparto.
2. Se è richiesto un permesso: ruolo effettivo = `Staff::getRole($dept, $isAssigned)`: (a) ruolo del reparto primario o del reparto esteso (`staff_dept_access.role_id`) se il ticket è in uno dei suoi reparti; (b) altrimenti, se l'agente è assegnatario e ha `extra.def_assn_role` (default true) → **ruolo primario**; (c) altrimenti un ruolo fittizio con il solo permesso `ticket.create` (= sola lettura). Poi `role->hasPerm($perm)`.

### 4.2 Agente → elenco (code/ricerche): `Staff::getTicketsVisibility()`
```
assigned = staff_id = ME
        OR thread.referrals.agent = ME
        OR (child_thread.object_type='C' AND child_thread.referrals.agent = ME)
        OR team_id IN myTeams OR thread.referrals.team IN myTeams OR child referrals team IN myTeams
visibility = (status.state IN (open, closed) AND assigned)
if assigned_only: return visibility
visibility OR= (dept_id IN myDepts OR thread.referrals.dept IN myDepts)   [ + state IN (open,closed) se exclude_archived ]
visibility OR= (child_thread C AND child referrals dept IN myDepts)
```
`myDepts` = reparto primario + reparti estesi (`staff_dept_access`). I ticket `archived` sono visibili solo tramite reparto (e solo se non esclusi); `deleted` non esistono (cancellati fisicamente).

### 4.3 Utente finale → ticket: `checkUserAccess($user)`
Vero se: è il proprietario; oppure l'org consente la condivisione (`SHARE_EVERYBODY`, o `SHARE_PRIMARY_CONTACT` e l'utente è contatto primario) e il proprietario è nella stessa org; oppure l'utente è autenticato tramite token di **questo** ticket come collaboratore; oppure è collaboratore del thread; oppure il ticket è parent di un merge non "visual" e l'utente ha accesso a uno dei figli.

### 4.4 Token di accesso (link "view ticket" via email)
`getAuthToken($user)` = `<o|c><algo>x<Base32(pack('VV', user_id, ticket_id))><base64(md5(user_id . created . ticket_id . SECRET_SALT, raw))[8:]>` (`o` = owner, `c` = collaborator, algo=1). Inserito come `%{recipient.ticket_link}` = `<base>/view.php?auth=<token>`. `view.php` decodifica il token e autentica una sessione "TicketUser" limitata a quel ticket. Esiste anche il vecchio `auth_token`/`client_link` (`view.php?t=<number>` con email). Se `allow_auth_tokens=0` i link richiedono login.

`sendAccessLink($user)`: invia il contenuto `access-link` (tabella `content`) con l'URL tokenizzato.

## 5. Stato: `setStatus($status, $comments, &$errors, $set_closing_agent=true, $force_close=false)`

1. Se c'è un agente corrente deve avere un ruolo nel reparto.
2. Controllo permessi (solo se il ticket ha già uno stato): verso `closed` richiede `ticket.close`; verso `deleted` → se `ticket.delete` esegue **`delete()`** (hard delete) altrimenti false.
3. Stesso stato → true.
4. Verso **closed**:
   - `isCloseable()` (salvo `force_close`): non chiudibile se mancano campi con `CLOSE_REQUIRED` (non disabilitati dal topic), se ha **task aperti**, o se `require_topic_to_close` e manca il topic.
   - `closed = lastupdate = NOW()`; se agente corrente e `set_closing_agent` → `staff_id = agente` (staff_id è "sovraccarico": assegnatario se aperto, **agente che ha chiuso** se chiuso).
   - `clearOverdue()` (azzera isoverdue, duedate passata, est_duedate passata).
   - Dopo il salvataggio: evento `closed` con `{status:[id,nome]}` che **annulla** i precedenti `closed`; cancella bozze del ticket.
   - Se `auto_refer_closed` → referral del thread all'agente assegnato (o all'agente corrente) così continua a vederlo.
5. Verso **open** (riapertura): se era chiuso e riapribile: riassegna all'agente che lo aveva (o ultimo rispondente) se disponibile (non in ferie, attivo) e con accesso al reparto e il reparto non ha `DISABLE_REOPEN_AUTO_ASSIGN`; altrimenti non assegnato. `closed=NULL`, `lastupdate=reopened=NOW()`, evento `reopened` (annulla `closed`), ricalcolo `est_duedate`. `isanswered=0`.
6. Altri state (archived) → false (solo via admin/plugin).
7. Se `comments` → nota interna "Status Changed" con alert.
8. Se nessun callback evento → evento `edited` con `{status: id}`.

`isReopenable()` = lo stato chiuso ha `allowreopen` + `reopenstatus` configurati **e** il reparto non è archiviato **e** il topic (se presente) consente la riapertura (non archiviato).
`reopen()` → `setStatus(status.reopenstatus ?: default_ticket_status_id)`.

Il salvataggio di un ticket con `status_id` cambiato invalida la cache dei contatori code (`SavedQueue::clearCounts`).

## 6. Assegnazione, claim, rilascio, trasferimento, referral

### 6.1 Assegnatario
Un ticket può essere assegnato contemporaneamente ad un **agente** (`staff_id`) e ad un **team** (`team_id`). `getAssignee()` (solo se aperto): agente se presente, altrimenti team. ID formattato `s<id>` / `t<id>`.

### 6.2 `assign(AssignmentForm $form, &$errors, $alert=true)`
- Target Staff: errore se già assegnato a lui, se non disponibile (`isAvailable` = attivo e non in ferie), se il reparto non consente (`Dept::canAssign`: `ASSIGN_PRIMARY_ONLY` → solo membri primari; `ASSIGN_MEMBERS_ONLY` → solo membri primari/estesi). Se l'agente assegna a sé stesso = **claim** (nessun alert, evento `{claim:true}`), altrimenti evento `{staff:[id, nome]}`. Rimuove eventuale referral verso quell'agente.
- Target Team: errore se già assegnato, se il reparto non consente o team non attivo; evento `{team:id}`; rimuove referral verso il team.
- Salva, `logEvent('assigned')`, `object.edited`, `onAssign()` (nota interna con commento + alert), se richiesto (`refer` nel form) mantiene il referral al precedente assegnatario.
- Assegnare un ticket chiuso lo **riapre** (`onAssign`).

### 6.3 `claim()` (da UI "Claim")
Richiede `ticket.edit`? (controller: `PERM_EDIT`), ticket aperto e non assegnato; l'agente deve essere disponibile e assegnabile nel reparto. → `assignToStaff(me)`.

### 6.4 Auto-claim su risposta
In `postReply`: se `auto_claim_tickets=1`, il reparto non ha `DISABLE_AUTO_CLAIM`, il ticket è aperto e senza agente → `staff_id = agente che risponde`.

### 6.5 `release($info)` / `unassign()`
Rimuove agente e/o team (solo ticket aperti). Evento `released` con `{staff, team}` (dal controller AJAX).

### 6.6 `transfer(TransferForm $form, &$errors, $alert=true)`
- Richiede `ticket.transfer`; reparto destinazione obbligatorio e diverso dall'attuale.
- Se il nuovo reparto ha `ASSIGN_MEMBERS_ONLY` e l'agente assegnato non ne è membro → rimuove l'assegnazione agente.
- Riapre se chiuso.
- SLA: se il ticket non ha SLA o è **TRANSIENT** → prende lo SLA del nuovo reparto (se definito).
- Evento `transferred` `{dept: nome}`; rimuove eventuale referral verso il nuovo reparto.
- Commento → nota interna "Ticket transferred from X to Y".
- Opzione `refer` → referral al reparto di origine (così chi era nel vecchio reparto continua a vederlo).
- Alert `transfer.alert` (se `transfer_alert_active` e il reparto ha membri per alert): assegnatario (o membri del team assegnato) se `transfer_alert_assigned`; se non assegnato e `transfer_alert_dept_members` → membri del reparto; `transfer_alert_dept_manager` → manager. Esclusi non disponibili e duplicati.

### 6.7 `refer(ReferralForm)`
Condivide il ticket con agente/team/reparto senza cambiarne proprietà: crea `thread_referral`, evento `referred` `{staff|team|dept}`. Errori se già assegnato a quel target/già nel reparto o agente non disponibile. I referral danno **visibilità** (non permessi aggiuntivi: il ruolo è determinato dal reparto). Si rimuovono via `/tickets/<id>/referrals`.

### 6.8 `changeOwner($user)`
Richiede `ticket.edit`; cambia `user_id`, rimuove il nuovo owner dai collaboratori, evento `edited` `{owner, fields:{'Ticket Owner': nome}}`.

## 7. Post nel thread

### 7.1 `postMessage($vars, $origin, $alerts=true)` (messaggio del cliente/utente)
1. IP da `vars.ip`/REMOTE_ADDR.
2. Se il ticket è un **child** di un merge non "visual" → il messaggio va al **parent**.
3. Se `userId` ≠ owner: individua l'utente (per id o dall'header `From`) e lo aggiunge come collaboratore.
4. Destinatari dell'entry (`thread_entry_recipients`): con `reply-to` (ticket creato da agente) secondo selezione; da web: tutti (owner+collaboratori attivi) escluso chi scrive.
5. `thread->addMessage()` → entry tipo M (vedi doc 05), `setLastMessage`.
6. **Collaboratori da email**: se ci sono `recipients` (To/Cc) e (origin ≠ email o `add_email_collabs=1`) e il messaggio è arrivato su un indirizzo locale (`to-email-id`): ogni destinatario (eccetto `delivered-to`) diventa collaboratore; **attivo** solo se il messaggio è dell'owner (aggiunti da collaboratori → inattivi, richiedono approvazione staff). Evento `collab` `{add:{uid:{name,src}}}`.
7. Auto-risposta: disattivata per bounce/auto-reply (anche niente riapertura); `vars.autorespond` può forzare.
8. `onMessage()`: `isanswered=0`, `lastupdate=NOW()`; **riapre** il ticket se chiuso e riapribile (non per bounce); auto-risposta `message.autoresp` all'autore (owner o collaboratore) se `message_autoresponder=1`, reparto con `message_auto_response=1`, autore non è email di sistema.
9. Se `message_autoresponder_collabs=1` e origin ≠ email → `notifyCollaborators()` (template `ticket.activity.notice` agli altri partecipanti, escluso l'autore).
10. Alert staff `message.alert` (se `message_alert_active`): ultimo rispondente (`message_alert_laststaff`), assegnatario o membri team (`message_alert_assigned`), manager reparto, account manager org (`message_alert_acct_manager`). Esclusi non disponibili/duplicati.
11. `object.created` `{type:message, uid}`.

### 7.2 `postReply($vars, &$errors, $alert=true, $claim=true)` (risposta agente, visibile al cliente)
1. Poster = agente; destinatari = `getRecipients($vars['reply-to'], $vars['ccs'])` → `reply-to` ∈ `all` (owner + collaboratori attivi selezionati), `user` (solo owner), `none` (nessuna email).
2. `thread->addResponse()` → entry tipo R (con flag REPLY_ALL/REPLY_USER).
3. `reply_status_id` → cambio stato contestuale (es. "Reply and Close").
4. Auto-claim (§6.4).
5. `onResponse()` → `isanswered=1` + `onActivity` (alert note).
6. Se `alert`: email mittente = `from_email_id` (scelta dall'agente) o email del reparto; firma: `mine` (firma agente) / `dept` (firma reparto se pubblico) / nessuna; nome mittente secondo preferenza agente (`mine` nome agente salvo `hide_staff_name`, `dept`, `email`). Template **`ticket.reply`** con `%{response}`, `%{signature}`, `%{staff}`, `%{poster}`; se l'unico destinatario è l'owner e ci sono collaboratori, aggiunge `recipient.ticket_link`. Allegati se `email_attachments`.
7. Il controller verifica **lock** (se abilitato: lock presente, dell'agente, non scaduto/rinnovabile, `lockCode` del form = `lock.code`) e che l'email non sia in banlist. Gestisce i collaboratori spuntati (attiva/disattiva) e rilascia il lock, cancella la bozza `ticket.response.<id>`.

### 7.3 `postNote($vars, &$errors, $poster, $alert=true)` (nota interna)
- Poster agente/sistema/stringa; `thread->addNote()` → entry N.
- `note_status_id` → cambio stato.
- `onActivity()` con attività "New Internal Note" (alert `note.alert` se `note_alert_active`: ultimo rispondente, assegnatario/membri team, manager reparto; escluso l'autore; se ticket chiuso solo a chi ha ancora accesso).
- `logNote($title, $note, $poster='SYSTEM', $alert)` è la scorciatoia usata da tutto il sistema per note automatiche.

### 7.4 `postCannedReply($canned, $message, $alert)`
Risposta automatica da canned (filtro `canned`): sostituisce variabili, allega i file della canned, poster "SYSTEM (Canned Reply)", `postReply` senza alert e senza claim, ticket lasciato **unanswered**, invia template **`ticket.autoreply`** all'owner (in risposta al Message-Id originale).

## 8. SLA, scadenze, overdue

### 8.1 Due date
- `duedate`: scadenza manuale (agente/API). Ha priorità.
- `est_duedate`: calcolata = `SLA.addGracePeriod(reopened ?: created, schedule)`.
- `getEstDueDate()` = `duedate ?: est_duedate`.
- `updateEstDueDate()` ricalcola `est_duedate` (e azzera overdue) ed è chiamato su creazione, riapertura, cambio SLA/duedate, update.

### 8.2 Calcolo con orario lavorativo
`SLA::addGracePeriod($date, $schedule)`: schedule = **schedule del reparto** → altrimenti schedule dello SLA → altrimenti `schedule_id` di sistema. Se esiste e ha voci → `BusinessHours::addWorkingHours($date, grace_period)`:
1. Converte la data nel fuso dello schedule.
2. Genera le occorrenze delle voci dello schedule (giorni lavorativi con ora inizio/fine) da `date` a `date + 72h` (finestra che si estende iterativamente), e le occorrenze delle festività (schedule-festività associati).
3. Scorre i giorni lavorativi in ordine: salta le ore dopo la chiusura del giorno corrente; se è festività intera salta il giorno, parziale conta solo il tempo prima della festività; somma i secondi lavorativi (parziali se si parte a metà giornata); quando supera le ore richieste fa backtrack della differenza.
4. Senza schedule: aggiunge semplicemente `grace_period` ore.

Tipi di ricorrenza delle voci: `never` (una volta), `daily`, `weekdays` (lun–ven), `weekends`, `weekly` (giorno `day` 1=lun..7=dom), `monthly` (giorno N del mese oppure "n-esimo <giorno> del mese"), `yearly` (data o "n-esimo/ultimo <giorno> di <mese>"). Ogni voce ha `starts_on/at`, `ends_on/at`, `stops_on`.

### 8.3 Overdue
- Cron `Ticket::checkOverdue()` (max 100 per run): ticket con `isoverdue=0`, stato open e (`duedate IS NULL AND est_duedate < NOW()` oppure `duedate < NOW()`) → `markOverdue()`.
- `markOverdue($whine=true)`: solo ticket aperti; `isoverdue=1`, evento `overdue`, `onOverdue()`.
- `onOverdue`: se lo SLA ha `NOALERTS` niente alert; altrimenti se `overdue_alert_active`: assegnatario (o membri team) se `overdue_alert_assigned`; se non assegnato e `overdue_alert_dept_members` → membri reparto; `overdue_alert_dept_manager` → manager. Template **`ticket.overdue`**.
- Manualmente: solo il **manager del reparto** può marcare overdue (azione `overdue`).
- Una nuova `duedate` futura azzera `isoverdue`.

### 8.4 SLA transient
Se lo SLA del ticket è TRANSIENT (o assente), su cambio reparto (transfer) o update del topic, lo SLA viene riselezionato (`selectSLAId`).

## 9. Lock (anti-collisione)

- `config.ticket_lock`: 0 disabilitato, 1 lock all'apertura della vista, 2 lock all'attività (default: il JS acquisisce il lock quando l'agente inizia a scrivere).
- `config.autolock_minutes` (default 3): durata.
- `POST /scp/ajax.php/lock/ticket/<tid>` → `acquireLock`: se esiste lock non scaduto di un altro agente → errore (mostra chi lo possiede); se è suo → rinnova; altrimenti crea `lock` (`code` casuale 10 char, `expire = NOW()+N min`) e `ticket.lock_id`. Risposta JSON con `id`, `time` (secondi), `code`.
- `POST /lock/<id>/ticket/<tid>/renew`, `POST /lock/<id>/release`.
- Il form di risposta/nota include `lockCode`; il submit è rifiutato se il lock non è più dell'agente o il codice non coincide.
- Cron `Lock::cleanup()` elimina i lock scaduti. Al logout si rimuovono i lock dell'agente.

## 10. Matrice notifiche (email) del ticket

Tutti i template provengono dal **gruppo template del reparto** (`department.tpl_id` → default `default_template_id`). Mittenti: `autoresp_email_id` del reparto (auto-risposte), `email_id` del reparto o default (alert e risposte). Nessun alert ad agenti non disponibili (inattivi/in ferie) né duplicati.

| Evento | Template | Destinatari | Condizioni (config) |
|---|---|---|---|
| Nuovo ticket (utente) | `ticket.autoresp` | owner | `ticket_autoresponder`, reparto `ticket_auto_response`, topic/email non `noautoresp`, non da email di sistema, non bounce/auto-reply, nessuna canned |
| Nuovo ticket (alert staff) | `ticket.alert` | membri reparto per alert (solo se non assegnato, `ticket_alert_dept_members`), manager (`ticket_alert_dept_manager`), account manager org (`ticket_alert_acct_manager`), admin email (`ticket_alert_admin`, se reparto non ALERTS_DISABLED) | `ticket_alert_active`, reparto con membri per alert |
| Nuovo ticket aperto da staff | `ticket.notice` | owner (+ collaboratori secondo reply-to) | `ticket_notice_active`, reply-to ≠ none |
| Limite ticket aperti | `ticket.overlimit` | owner | `overlimit_notice_active` (+ alert admin sempre) |
| Nuovo messaggio (utente) | `message.autoresp` | autore | `message_autoresponder`, reparto `message_auto_response` |
| Nuovo messaggio (collaboratori) | `ticket.activity.notice` | altri partecipanti | `message_autoresponder_collabs`, origin ≠ email |
| Nuovo messaggio (alert staff) | `message.alert` | ultimo rispondente / assegnatario o team / manager / account manager | `message_alert_*` |
| Risposta agente | `ticket.reply` | owner + collaboratori attivi selezionati | reply-to ≠ none |
| Canned auto-reply | `ticket.autoreply` | owner | filtro canned |
| Nota interna / attività | `note.alert` | ultimo rispondente / assegnatario o team / manager | `note_alert_*` |
| Assegnazione | `assigned.alert` | agente (`assigned_alert_staff`) o membri team (`assigned_alert_team_members`) o team lead (`assigned_alert_team_lead`) se team con alert abilitati | `assigned_alert_active` |
| Trasferimento | `transfer.alert` | assegnatario/team, membri reparto (se non assegnato), manager | `transfer_alert_*` |
| Overdue | `ticket.overdue` | assegnatario/team, membri reparto (se non assegnato), manager | `overdue_alert_*`, SLA senza NOALERTS |

"Membri per alert" del reparto (`getMembersForAlerts`): agenti attivi e non in ferie che hanno il reparto come primario, oppure accesso esteso con flag ALERTS **e** reparto con `group_membership = ALERTS_DEPT_AND_EXTENDED`; vuoto se reparto `ALERTS_DISABLED`. Il manager è incluso nei membri se lo è.

## 11. Collaboratori (CC)

- `thread_collaborator` (user_id, flags ACTIVE/CC). Owner non può essere collaboratore.
- Aggiunti: dallo staff (`addcc`, dialog collaboratori, campo CC nella risposta), da email (To/Cc), da org (auto), dai merge.
- Attivi = ricevono le email; inattivi = memorizzati ma esclusi.
- `collaborator_ticket_visibility=1`: i collaboratori vedono il ticket nel portale (lista ticket) oltre che via link.
- `disable_agent_collabs`: se 1, gli agenti non possono essere aggiunti come collaboratori (email di agenti scartate).
- Eventi `collab` con `add`/`del`.

## 12. Merge e link

Funzionalità "Merge Tickets" e "Link Tickets" (`/scp/ajax.php/tickets/<tid>/merge|link`):

- `ticket_pid` del child punta al parent; parent ha flag `PARENT`.
- Tipi (flag): **combine** (`COMBINE_THREADS`: i thread dei figli vengono mostrati fusi nel parent), **separate** (`SEPARATE_THREADS`: mostrati separati), **visual/link** (`LINKED`: solo collegamento visivo, nessuna fusione). `setMergeType(0=separate,1=combine,2=link,3=normale)`.
- Permessi: `ticket.merge` / `ticket.link` su tutti i ticket coinvolti (o referral).
- `manageMerge`: il primo ticket della lista è il parent; gestisce cambio da link a merge, cambio parent, ordinamento (`sort`); eventi `merged`/`linked` su entrambi i ticket `{ticket:'Ticket #N', id}`; se reparti diversi (merge) → referral del parent al reparto del child + evento `referred`.
- `merge` (non visual), per ogni child:
  - aggiunge al parent come collaboratori l'owner del child e (se `participants=all`) i suoi collaboratori;
  - **le entry del thread del child vengono spostate fisicamente nel thread del parent**: per ognuna si crea `thread_entry_merge` (`data = {"thread": <thread_id originale>}`), si imposta il flag `CHILD` e `thread_entry.thread_id = <thread del parent>`; il thread del child resta (vuoto) con `object_type='C'` e `extra={"ticket_id": <parent>, "number": "<numero child>"}` (serve a ricollegare eventuali email future e a ricostruire l'origine). Se il child era a sua volta il risultato di un merge precedente, le entry già spostate vengono riassegnate al nuovo parent;
  - stato del child forzato a `childStatusId` (chiusura forzata), parent eventualmente a `parentStatusId`;
  - `move-tasks` o `delete-child` → i task del child passano al parent; `delete-child` → elimina il child.
- I messaggi successivi indirizzati al child (es. risposte email) finiscono nel parent.
- `unlink()`: rimuove pid/flag, evento `unlinked` su entrambi.
- Cancellare un parent: i figli tornano normali (pid NULL, thread → `T`).

## 13. Modifica ticket

### 13.1 `update($vars, &$errors)` (form "Edit Ticket", permesso `ticket.edit`)
Campi: `topicId` (obbligatorio, attivo), `slaId`, `duedate` (non su ticket chiuso, futura), `source` (valida), `user_id`, `note` (opzionale, diventa nota "Ticket Updated"), form dinamici del ticket (validazione campi visibili/modificabili da staff; possibilità di **rimuovere** form aggiuntivi o aggiungerne). Registra evento `edited` con le differenze `{campo:[old,new], fields:{field_id:[old,new]}}`. Riseleziona lo SLA se transient e non cambiato esplicitamente; ricalcola due date; `model.updated`.

### 13.2 `updateField($form)` (modifica inline di un singolo campo da vista ticket)
Campi speciali: `priority`, `sla`, `topic`, `source`, `duedate` (convertita in fuso DB, futura) + qualunque campo dinamico (`/tickets/<id>/field/<fid>/edit`). Errore se valore invariato o non modificabile. Evento `edited`, commento opzionale come nota, `lastupdate=NOW()`.

## 14. Cancellazione `delete($comments)`
1. DELETE della riga ticket.
2. Se parent: ogni child torna ticket normale (pid NULL, merge type 3, thread → `T`).
3. Se child: se il parent non ha più figli → torna normale. Altrimenti (non child) elimina il **thread** (entries, eventi, allegati, collaboratori, referral).
4. Evento `deleted`, elimina form entries (e valori), bozze `ticket.%.<id>`, riga `ticket__cdata`.
5. Log debug "Ticket #N deleted by X" (+ commenti).
I **task** collegati non vengono eliminati.

## 15. Azioni di massa (code)
`/scp/ajax.php/tickets/mass/<action>[/<what>]` (GET = dialog, POST = esecuzione su `tids[]`), azioni: `assign` (sotto-target `agents`/`teams`/`me`), `claim`, `transfer`, `refer`, `merge`, `link`, `delete` (richiede `ticket.delete` globale + per-ticket), `reopen`, `close`. Il cambio stato di massa usa invece `/tickets/status/<state>` (GET dialog) e `POST /tickets/status/<state>`. Ogni azione verifica il permesso **sul singolo ticket** (`checkStaffPerm($thisstaff, PERM_…)`) e riporta "N di M ticket <verbo>"; le operazioni non consentite vengono saltate.

Altre azioni singole via AJAX: `release` (`ticket.release` o manager del reparto; evento `released` con `{staff, team}` rilasciati), `mark/answered|unanswered` (`ticket.markanswered` o manager), `mark/overdue` (manager), `claim`, `refer`, `referrals` (gestione/rimozione referral), `change-user`, `transfer`, `assign/<agents|teams>`.

## 16. Esportazione/stampa
- **PDF** (`?a=print&psize=Letter|A4…&notes=1&events=1`): `Ticket2PDF` (mPDF) con intestazione, dettagli, form, thread (note opzionali, eventi opzionali). La dimensione carta viene ricordata in sessione / preferenza agente.
- **ZIP** (`?a=zip&notes=1&tasks=1`): `TicketZipExporter` (thread HTML + allegati + task).
- **CSV** delle code (doc 09).

## 17. Variabili template del ticket (`%{ticket.*}`)
`id`, `number`, `subject`, `name` (PersonsName: `.first`, `.last`, `.full`, `.short`, `.shortformal`, `.legal`, `.lastfirst`, `.original`), `email`, `phone`, `source`, `status` (`.name`, `.state`), `priority` (`.desc`…), `dept` (`.name`, `.manager`, `.signature`…), `topic` (`.name`), `sla`, `staff` (agente assegnato/chiusura), `team`, `assigned`, `create_date`, `due_date`, `close_date`, `last_update` (FormattedDate: `.long`, `.short`, `.time`, `.full`, `.humanize`, `.date`…), `user` (`.name`, `.email`, `.phone`, `.org`, campi form utente), `recipients` (lista nomi), `thread` (`.original`, `.lastmessage`, `.complete`…), `client_link`, `staff_link`, `auth_token`, + ogni campo del form ticket per nome (`%{ticket.<field_name>}`). Vedi doc 05 per il motore delle variabili.

## 18. Statistiche utente
`getUserStats($user)` (legacy) e `User::getNumOpenTickets()`/`getNumClosedTickets()` usati per il limite e per il portale.
