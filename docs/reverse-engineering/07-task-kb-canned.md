# 07 — Task, Knowledge Base (FAQ/categorie), Canned response, Pagine

## 1. TASK (`class.task.php`, `scp/tasks.php`, `include/ajax.tasks.php`)

### 1.1 Concetto
Attività **interna** (non visibile ai clienti), assegnabile ad agente/team di un reparto, con un proprio thread (descrizione, risposte interne, note), numerazione propria, scadenza. Può essere legata ad un ticket (`object_type='T'`, `object_id=ticket_id`) oppure indipendente.

### 1.2 Dati
- Riga `task` (doc 02) + form tipo `A` ("Task Details": `title`, `description`) materializzato in `task__cdata`.
- Stato: solo **aperto/completato** tramite flag `ISOPEN` (non usa `ticket_status`). `getStatus()` = "Open" / "Completed".
- `closed` datetime.
- `ISOVERDUE` flag: esiste ed è filtrabile, ma **nel core non esiste un job che marchi i task overdue** (le impostazioni `task_overdue_alert_*` e il template `task.overdue.alert` non sono usati da alcun codice). In una riscrittura si può implementare analogamente ai ticket.

### 1.3 Permessi (ruolo nel reparto del task)
`task.create`, `task.edit`, `task.assign`, `task.transfer`, `task.reply` (post risposta), `task.close`, `task.delete`.
Accesso (`checkStaffPerm`): l'agente vede il task se ha accesso al reparto del task, **oppure** il task è aperto e assegnato a lui o a un suo team. Permessi specifici dal ruolo dell'agente nel reparto del task (`Staff::getRole(dept)`).

### 1.4 Creazione `Task::create($vars)`
- Richiede agente con `task.create` (globale su almeno un reparto).
- Input: `object_id`/`object_type` (ticket), `internal_formdata` = `{dept_id (obbligatorio), assignee (Staff|Team), duedate}`, `default_formdata` = valori del form A (`title`, `description`).
- Numero: `cfg->getNewTaskNumber()` (sequenza `task_sequence_id` default 2 "Tasks Sequence", formato `task_number_format` default `#`; sequenza 0 → casuale).
- Crea task (`flags=ISOPEN`), form data, thread `A` con **descrizione** come prima entry (flag ORIGINAL_MESSAGE; tipo messaggio "M" postata dall'agente), evento `created`.
- Assegnazione se l'agente ha `task.assign` nel reparto.
- `onNewTask()`: alert **`task.alert`** se `task_alert_active` e reparto non ALERTS_DISABLED: manager (`task_alert_dept_manager`), membri per alert (`task_alert_dept_members`) — se il reparto è ALERTS_ADMIN_ONLY solo admin; admin email (`task_alert_admin`). Esclusi: autore, non disponibili, duplicati, chi non ha accesso.
- `Signal::send('task.created')`.
Origini UI: "Add Task" in vista ticket (`/scp/ajax.php/tickets/<tid>/add-task`), da thread entry (azione `create_task`), da `scp/tasks.php?a=open` / `/scp/ajax.php/tasks/add`.

### 1.5 Stato
- `setStatus('closed')`: verifica `isCloseable()` (campi obbligatori del form A mancanti); `closed=NOW()`, evento `closed`, se legato a ticket → nota sul ticket "Task N Closed".
- `setStatus('open')`: evento `reopened` (annulla closed), se legato a ticket → **riapre il ticket** e aggiunge nota "Task N Reopened".
- Commento opzionale → nota "Status changed to …".
- Un ticket con task aperti **non può essere chiuso**.

### 1.6 Assegnazione / claim / trasferimento
Analoghi ai ticket (doc 04 §6) con template `task.assignment.alert` (agente `task_assignment_alert_staff`, team lead `…_team_lead`, membri team `…_team_members`) e `task.transfer.alert` (`task_transfer_alert_assigned`, `…_dept_manager`, `…_dept_members`). Eventi `assigned`, `transferred`, `released`.

### 1.7 Thread del task
- `postReply()` (risposta interna, tipo R): opzione `task:status` per cambiare stato, alert attività `task.activity.alert` (`task_activity_alert_laststaff`, `…_assigned`, `…_dept_manager`), notifica collaboratori (`task.activity.notice`) se richiesto (`emailcollab`).
- `postNote()`: nota interna con alert attività.
- I task non hanno messaggi dei clienti; possono avere collaboratori (utenti) notificati.

### 1.8 Altro
- `update($forms, $vars)` (modifica form + duedate), `updateField()` inline.
- `delete()`: elimina thread, evento `deleted`, bozze `task.%.<id>`, form entries; log.
- Export PDF (`Task2PDF`), azioni di massa (`/tasks/mass/<action>`: assign, claim, transfer, close, reopen, delete…).
- Code dei task: `scp/tasks.php` usa filtri fissi (non queue configurabili): "Open", "Assigned to me", "Overdue", "Closed", ricerca; ordinamenti per numero/data/titolo/reparto/assegnatario/scadenza. Statistiche agente `Task::getStaffStats()` (assegnati, chiusi).

## 2. KNOWLEDGE BASE

### 2.1 Modello
- `faq_category` (con sottocategorie `category_pid`), visibilità `ispublic`: 0 privata (solo agenti), 1 pubblica, 2 in evidenza.
- `faq`: domanda (univoca), risposta HTML, keyword, note interne, `ispublished`: 0 interno, 1 pubblico, 2 in evidenza ("featured").
- FAQ ↔ help topic (`faq_topic`): classificazione delle FAQ per help topic; nel portale la KB può essere filtrata per topic (`?topicId=`) e la pagina di categoria/ricerca mostra i topic correlati.
- Allegati (`attachment.type='F'`), anche per lingua (`attachment.lang`).
- Traduzioni domanda/risposta (`translation`, tag `faq.question.<id>`, `faq.answer.<id>`), titoli/descrizioni categorie.

### 2.2 Regole di visibilità
- FAQ **pubblicata** ⇔ `ispublished ≠ 0` **e** categoria pubblica (`ispublic ∈ {1,2}`).
- KB cliente abilitata ⇔ `config.enable_kb=1` **e** esiste almeno una FAQ pubblicata; se `restrict_kb=1` solo utenti loggati (non guest).
- In evidenza: FAQ con `ispublished=2` in categorie pubbliche → mostrate in home portale ("Featured Questions"); categorie con `ispublic=2` mostrate in home.

### 2.3 Portale (`/kb/index.php`, `/kb/faq.php`)
- Elenco categorie pubbliche con conteggio FAQ, ricerca (keyword su domanda/risposta/keyword via full-text o LIKE, filtro per topic/categoria), dettaglio FAQ con allegati, "Print", lingua.
- Home (`index.php`): pagina "landing" + ricerca KB + FAQ in evidenza + bottoni "Open a New Ticket"/"Check Ticket Status".

### 2.4 Staff (`scp/kb.php`, `scp/faq.php`, `scp/categories.php`)
- Consultazione per tutti gli agenti; gestione (crea/modifica/elimina FAQ e categorie, pubblica/nascondi) richiede permesso **`faq.manage`** (permesso globale agente).
- Inserimento FAQ in una risposta: link/contenuto (`/scp/ajax.php/kb/faq/<id>`).
- Cambio rapido della visibilità di una FAQ (`/scp/ajax.php/kb/faq/<id>/access`, richiede `faq.manage`): imposta `ispublished` (interna/pubblica/in evidenza).
- PDF di una FAQ.

## 3. CANNED RESPONSE (`class.canned.php`, `scp/canned.php`)
- Risposte predefinite: titolo univoco, testo HTML con variabili `%{ticket.*}`, reparto (`dept_id`, 0 = tutti), abilitata, lingua, note, allegati (`type='C'`).
- Gestione con permesso **`canned.manage`** (nel ruolo).
- `getCannedResponses($deptId)`: risposte abilitate dei reparti dell'agente + globali (0); in vista ticket filtrate per il reparto del ticket (+ globali).
- Uso: menu a tendina nell'editor di risposta → `/scp/ajax.php/tickets/<tid>/canned-resp/<id>.json` restituisce `{response (variabili già sostituite col ticket), files[]}`; gli allegati vengono aggiunti al form.
- Uso automatico: azione filtro `canned` → `postCannedReply` (doc 04 §7.4).
- Abilitazione funzione: `config.enable_premade`.
- Eliminazione: rimuove allegati; i filtri che la referenziano restano (azione senza effetto).

## 4. PAGINE / CONTENUTI (`class.page.php`, `scp/pages.php`)
- Tabella `content`: pagine selezionabili (`landing`, `offline`, `thank-you`, `other`) e contenuti di sistema (banner, email registrazione/reset/link accesso/2FA).
- Config: `landing_page_id`, `offline_page_id`, `thank-you_page_id`.
- Pagine `other` attive pubblicate su `/pages/<slug>` (slug = nome slugificato).
- Help topic può avere una pagina "thank you" specifica (`page_id`).
- Traduzioni (`type='article'`, JSON `{name, body}`), allegati/immagini inline (`type='P'`).
- Non si possono eliminare/disattivare le pagine attualmente in uso come default.

## 5. QUICK NOTES (`class.note.php`)
Note interne rapide su **utenti** (`ext_id='U<id>'`) e **organizzazioni** (`'O<id>'`) dalla loro scheda staff: crea (`/scp/ajax.php/users/<id>/note`, `/orgs/<id>/note`), modifica/elimina (`/scp/ajax.php/note/<id>`). Ordinate per `sort, created`.
