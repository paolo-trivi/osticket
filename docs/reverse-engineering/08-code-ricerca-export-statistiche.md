# 08 — Code (queue), ricerca avanzata, full-text, export, dashboard/statistiche

File: `class.queue.php`, `class.search.php`, `class.export.php`, `class.report.php`, `scp/tickets.php`, `scp/queues.php` (admin), `include/ajax.search.php`, `include/staff/templates/queue-*.tmpl.php`, `scp/dashboard.php`.

## 1. Concetti

- **CustomQueue** (tabella `queue`): definizione di una vista su ticket (`root='T'`) o task (`root='A'`): criteri + colonne + ordinamenti + campi export + quick filter.
- **Coda** (flag `QUEUE`): appare nella navigazione a tab/sottomenu. Di sistema (`staff_id=0`, `PUBLIC`) o personale.
- **Ricerca salvata** (`SavedSearch`, senza flag `QUEUE`): appare in "My Searches" dell'agente (o pubblica).
- **AdhocSearch**: ricerca temporanea memorizzata in sessione `$_SESSION['advsearch'][<key>]`, indirizzata come `queue=adhoc,<key>`.
- **Sotto-code**: `parent_id`; possono ereditare criteri (`INHERIT_CRITERIA`), colonne, ordinamenti, sort default, export dal padre. `path` = `/<id padre>/<id>/`.
- **Personalizzazione per agente**: `queue_config` (sort scelto, filtro, colonne) e `queue_columns` con `staff_id` dell'agente.

## 2. Criteri

`queue.config` JSON:
```json
{"criteria": [["status__state","includes",{"open":"Open"}],
              ["assignee","includes",{"M":"Me","T":"One of my teams"}],
              ["closed","period","td"],
              [":keywords", null, "testo libero"]],
 "conditions": []}
```
Ogni criterio = `[percorso_campo, metodo, valore]`. Il percorso è un path ORM relativo a `Ticket` (es. `status__state`, `dept_id`, `user__org__name`, `cdata__subject`, `topic_id`, `isanswered`, `isoverdue`, `assignee`, `staff_id`, `team_id`, `created`, `duedate`, `est_duedate`, `closed`, `lastupdate`, `reopened`, `source`, `thread__lastmessage`, `user__emails__address`, `thread_count`, `attachment_count`, `collaborator_count`, `task_count`, `reopen_count`, `merged`, `linked`, campi custom `answers!<form_id>__<field>`…). Più criteri = AND. `:keywords` = ricerca full-text.

### 2.1 Campi ricercabili
`Ticket::getSearchableFields()`: number, created, duedate, est_duedate, reopened, closed, lastupdate, assignee (Me / my teams / agente / team), staff_id, team_id, dept_id, sla_id, topic_id, source, isoverdue, isanswered, isassigned, merged, linked, thread_count, attachment_count, collaborator_count, task_count, reopen_count, ip_address, + campi del form ticket (`cdata`), + campi utente/organizzazione (via `user__…`), + `status__id`, `status__state`, `thread__lastmessage`, `thread__lastresponse`. Ricorsione nei modelli relazionati (fino a 2 livelli) tramite `getSearchableFields` di User, Organization, Dept, Topic, Thread…

### 2.2 Metodi (operatori) per tipo
| Tipo campo | Metodi |
|---|---|
| Testo | `set`, `nset`, `equal`, `nequal`, `contains`, `match` (regex) |
| Checkbox | `set` (checked), `nset` |
| Scelta/selezione/lista/reparto/topic/stato | `set`, `nset`, `includes`, `!includes` (valore = mappa id→label) |
| Numerico | `equal`, `greater`, `less` |
| Data/ora | `set`, `nset`, `equal` (giorno), `nequal`, `before`, `after`, `between`, `period` (`td` oggi, `yd` ieri, `tw` questa settimana, `tm` questo mese, `tq` trimestre, `ty` anno, `lw`, `lm`, `lq`, `ly` = precedenti), `ndaysago`, `ndays`, `future`, `past`, `distfut`, `distpast` |
| Assignee | `includes`/`!includes` con valori `M` (me), `T` (miei team), `s<id>`, `t<id>` |

Ogni campo traduce `(metodo, valore)` in una `Q` ORM (`getSearchQ`).

### 2.3 Costruzione query (`CustomQueue::getQuery`)
1. `getBasicQuery()`: `Ticket::objects()` (o query del padre se eredita) + `mangleQuerySet()` = applica ogni criterio come `filter(Q)`; `:keywords` → `SearchBackend::find()`.
2. Quick filter (`?filter=<valore>` sul campo `queue.filter`, es. reparto).
3. Ogni colonna aggiunge select/annotazioni/condizioni.
4. In `queue-tickets.tmpl.php`:
   - **Visibilità** agente (doc 04 §4.2) sempre applicata alle code; per le ricerche salvate dell'agente si può ignorare se ha permesso `search.all` ("può cercare tutto").
   - Code (non ricerche): esclusi i ticket figli di merge (`ticket_pid IS NULL OR flag LINKED`).
   - Ordinamento: colonna cliccata (`?sort=<col_id>&dir=0|1`, memorizzato in sessione per coda) oppure sort della coda (`?sort=qs-<sort_id>`) oppure sort default della coda oppure `-created`.
   - Paginazione: `PAGE_LIMIT` (preferenza agente o `max_page_size`), `?p=<n>`.
   - Full-text: sotto-query limitata a 500 risultati ordinati per rilevanza.
   - `DISTINCT ticket_id`.
5. Totale: `SavedQueue::getCount()` (cache).

### 2.4 Contatori code (`SavedQueue::counts($agent)`)
Una singola query aggregata con `COUNT(DISTINCT CASE WHEN <criteri coda> THEN ticket_id END)` per ogni coda visibile all'agente, sui ticket visibili (escludendo archiviati), solo thread `T`. Cache 5 minuti in APCu (o sessione) con chiave per agente; invalidata quando un ticket cambia stato. Code con ricerca full-text o senza criteri → `-`. Il contatore accanto alla tab di primo livello è mostrato solo se `queue_bucket_counts=1` ("Show top-level queue counts"); nel menu a tendina di ogni coda i contatori (coda e sotto-code) sono sempre caricati via AJAX. Endpoint `/scp/ajax.php/queue/counts`.

### 2.5 Colonne (`queue_column`)
- `primary` (campo ORM), `secondary` (fallback se primary vuoto), `filter` (formatter: `link:ticket`, `link:ticketP` (preview al passaggio mouse), `link:user`, `link:org`, `date:full`, `date:human` (relativo), `date:short`…, registrabili da plugin), `truncate` (`wrap`, `ellipsis`, `clip`, `lclip`), `annotations` (decorazioni), `conditions` (stile CSS condizionale: lista `{crit:[campo,metodo,valore], prop:{css}}` valutata in memoria su ogni riga), flag `SORTABLE`.
- Annotazioni disponibili: `TicketThreadCount` (n. messaggi), `TicketReopenCount`, `ThreadAttachmentCount` (icona graffetta), `TicketTasksCount`, `ThreadCollaboratorCount`, `OverdueFlagDecoration`, `MergedFlagDecoration`, `LinkedFlagDecoration`, `TicketSourceDecoration` (icona sorgente), `LockDecoration` (lucchetto), `AssigneeAvatarDecoration`, `UserAvatarDecoration`. Posizioni: `<` prima, `>` dopo, `a` sopra/dopo, `b` sotto/prima.
- Larghezza, intestazione e ordine per coda (`queue_columns`).

### 2.6 Ordinamenti (`queue_sort`)
`columns` = lista di path con `-` per DESC. La coda elenca gli ordinamenti disponibili (`queue_sorts`) nel menu "Sort", con uno di default (`queue.sort_id`).

### 2.7 Admin code (`scp/queues.php`, Settings → Tickets → Queues)
Creazione/modifica code di sistema (criteri tramite AdvancedSearchForm, colonne con editor, ordinamenti, export, quick filter, ereditarietà), ordinamento (`sort`), abilitazione/disabilitazione, eliminazione. Gli agenti possono creare code/ricerche personali dal pannello ("Add personal queue", "Save search").
Coda di default: `config.default_ticket_queue` (default 1 = Open), sovrascrivibile per agente (`default_ticket_queue_id`).

## 3. Ricerca

### 3.1 Ricerca rapida (barra di ricerca staff)
`tickets.php?a=search&query=…` (max 4 parole):
- email (o simile a email) → criterio `user__emails__address equal|contains`;
- numerico → `number contains`;
- altrimenti → `:keywords` (full-text).
Typeahead: `/scp/ajax.php/tickets/lookup?q=` (numero/email/oggetto) e `/users?q=` per utenti.

### 3.2 Ricerca avanzata
Dialog `/scp/ajax.php/tickets/search` (GET form, POST esegue → salva in sessione come adhoc), aggiunta di campi dinamicamente (`/search/field/<id>`), salvataggio come ricerca personale (`/search/save`), modifica (`/search/<id>`), eliminazione.

### 3.3 Full-text (`MysqlSearchBackend`)
- Indice `ost__search(object_type, object_id, title, content)` FULLTEXT.
- Indicizzati: ticket (`title = numero + oggetto`), thread entry (`H`: titolo + corpo testuale), utenti (`U`: nome + email), organizzazioni (`O`), FAQ (`K`).
- Aggiornamento sincrono via segnali (creazione/modifica), più reindicizzazione batch in cron (`IndexOldStuff`, 30 record × 60 batch per run) per tutto ciò che manca.
- Query: `MATCH(title, content) AGAINST (q IN NATURAL LANGUAGE MODE)` oppure `IN BOOLEAN MODE` se l'utente usa operatori `+ - ~ < > ( ) "…"` validi; minimo 3 caratteri; gli indirizzi email vengono quotati. Un risultato su thread entry/utente/org viene ricondotto al ticket (entry → thread → ticket, utente → suoi ticket).
- Ordinamento per `relevance`.
- Per utenti e organizzazioni la directory staff usa la stessa ricerca.

## 4. Export

### 4.1 Export code (CSV)
- `/scp/ajax.php/tickets/export/<queue_id>` o `/export/adhoc,<key>` (GET → dialog scelta campi/nome file/delimitatore; POST → avvio).
- Campi esportabili: `CustomQueue::getExportableFields()` (numero, date, oggetto, utente, email, priorità, reparto, topic, sorgente, stato, assegnatario, SLA, scadenze, conteggi, campi custom…). Selezione salvabile in `queue_export`.
- Flusso asincrono: la POST risponde subito **201 `{eid, interval}`**, chiude la sessione e genera il CSV in un file temporaneo (BOM UTF-8; delimitatore `,` o `;` secondo locale/scelta); il browser interroga `/scp/ajax.php/export/<eid>/check` ogni `interval` secondi e scarica il file quando pronto; se l'agente abbandona, il file viene **inviato per email** all'agente.
- Export utenti/organizzazioni/agenti/membri reparto/ticket di un utente/org (`/users/<id>/tickets/export`).

### 4.2 Export singolo ticket
PDF e ZIP (doc 04 §16).

## 5. Dashboard e statistiche (`scp/dashboard.php`, `class.report.php`)

- Basate **interamente su `thread_event`** (esclusi `annulled=1`).
- **Grafico** (linee per giorno, gRaphael) di tutti gli eventi del periodo (conteggio eventi distinti per nome e giorno, `thread_type='T'`, non annullati), con selezione data di inizio + periodo. I dati sono calcolati lato server e incorporati nella pagina come JSON (`$.drawPlots(...)`); la form fa POST su `dashboard.php`. *Nota*: la rotta AJAX `/scp/ajax.php/report/overview/*` referenzia `ajax.reports.php`, file **assente** nel repository 1.18 (rotta morta).
- **Tabelle** raggruppate per Reparto, Help Topic, Agente con colonne: Opened, Assigned, Overdue, Closed, Reopened, Deleted, **Service Time** (media ore tra evento `created` e `closed` dello stesso thread), **Response Time** (media ore tra un messaggio e la risposta agente `R` figlia, via `pid`).
- Restrizioni: per reparto solo i reparti dell'agente; per agente solo reparti gestiti (manager) o tutti con permesso `stats.agents`; per topic i topic visibili.
- Export CSV di ogni tabella (`POST export=<group>`).

## 6. Directory e altre liste staff
- `scp/directory.php`: rubrica agenti (nome, reparto, email, telefono, interno, mobile), ricerca, filtro reparto; visibilità limitata ai reparti dell'agente salvo permesso `visibility.agents`.
- `scp/users.php`, `scp/orgs.php`: directory utenti/organizzazioni con ricerca full-text, ordinamenti, azioni di massa (vedi doc 09).
