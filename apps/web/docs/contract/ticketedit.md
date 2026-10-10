# Contratto di scrittura — modifica del ticket (M2.3 parte B, area "ticketedit")

Verificato con 67 scenari differenziali (righe DB ed email identiche al PHP, operazioni PHP in
`test/diff/php/ops/ticketedit.php`):

```
OST_DIFF_TAG=ticketedit MAILPIT_SMTP_PORT=1027 MAILPIT_HTTP_PORT=8027 \
  npx vitest run -c vitest.diff.config.mts test/diff/ticket-edit*.diff.test.ts
```

| File di test | Scenari |
|---|---|
| `ticket-edit.diff.test.ts` | Ticket::update, Ticket::updateField, Ticket::changeOwner (20) |
| `ticket-edit-delete.diff.test.ts` | eliminazione da stato "deleted" e Ticket::delete (6) |
| `ticket-edit-collab.diff.test.ts` | collaboratori, segna scaduto, ban list (13) |
| `ticket-edit-merge.diff.test.ts` | link, scollegamento, merge combinato/separato (8) |
| `ticket-edit-mass.diff.test.ts` | azioni di massa (11) |
| `ticket-edit-entry.diff.test.ts` | modifica delle voci del thread (5) |
| `ticket-edit-export.diff.test.ts` | export CSV delle code (4, sola lettura: CSV confrontato) |

## File
| Livello | File | Contenuto |
|---|---|---|
| Dominio | `src/server/domain/ticket/edit.ts` | `updateTicket`, `updateTicketField`, `changeTicketOwner`, `selectSlaId` |
| Dominio | `src/server/domain/ticket/edit-answers.ts` | risposte dei form del ticket: lettura, risposte mancanti, salvataggio con cdata, rappresentazione per l'evento edited |
| Dominio | `src/server/domain/ticket/edit-values.ts` | `TICKET_SOURCE_KEYS`, `phpAssocJson`, `userDateToDb`, `dbDateToInput`, corpo delle note, `truncate` |
| Dominio | `src/server/domain/ticket/delete.ts` | `deleteTicket` (Ticket::delete), `deleteThread`, `deleteOrphanFiles`, `ticketHardDelete` (aggancio di `changeTicketStatus`) |
| Dominio | `src/server/domain/ticket/merge-flags.ts` | flag di merge, `setMergeType`, `setPid`, `childTickets` |
| Dominio | `src/server/domain/thread/ids.ts` | thread di ticket e task: `ticketThread` (thread T o C), `currentTicketThreadId`, `ticketThreadId`, `taskThreadId` |
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

## Convenzioni comuni
- `Ticket::save` passa da `TicketRecord`: solo i campi cambiati (confronto debole), `updated = NOW()`, `_search` T.
- Eventi con `logTicketEvent`/`logThreadEvent` (staff_id = assegnatario o agente se non assegnato). Dove il PHP
  produce JSON con chiavi in un ordine particolare (array misti) i dati sono serializzati con `phpAssocJson`.
- Tutte le operazioni ricontrollano sessione e permessi; ticket inaccessibile → `not_found`, permesso mancante → `denied`.

## Ticket::update (form "Modifica", scp/tickets.php a=update) — `updateTicket`
Permesso `ticket.edit`. Validazione come `Validator::process` + controlli del PHP:
- `topicId` numerico obbligatorio (anche `0`), topic esistente ma non attivo → `inactive`;
- `slaId`, `user_id` numerici se presenti; `source` tra Phone/Email/Web/API/Other;
- scadenza: non su ticket chiusi, interpretabile, nel futuro;
- form dinamici: campi memorizzabili, visibili e modificabili dall'agente (obbligatori per l'agente, validatori).
Con errori nessuna scrittura (`{error:"invalid", fields}`).

Campi dei form (qui e in `updateTicketField`): date lette nel fuso dell'agente (`$cfg->getTimezone()`, `currentTimezone`),
anche per il testo di `_search` (che ogni `Ticket::save` riscrive nel fuso dell'utente della richiesta: `bindRequestContext`
in `runWrite`, come il `$cfg->getTimezone()` globale del PHP). Un campo assente dall'input vale la risposta attuale per la validazione e il salvataggio
(`getClean()` = `Widget::parseValue`, `parseFieldOrAnswer`), mentre le modifiche dell'evento leggono il solo widget
(`getChanges`: assente → `null`, stranezza replicata); in `updateField` `FormField::save` salva proprio quel valore nullo.
Il vecchio valore di un campo data `NULL` o non interpretabile compare come `0` nell'evento (`DatetimeField::to_php`).

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
   Come `DynamicFormEntry::getChanges` le modifiche includono anche i campi che l'agente non vede o non può
   modificare: risultano cambiati nel valore nullo del widget (`[vecchio,null]`) anche se la risposta non si salva
   (stranezza replicata).
6. Se lo SLA non è stato cambiato e manca o è transitorio (`0x8`): `selectSLAId` (reparto → topic → `default_sla_id`).
7. `updateEstDueDate` (est_duedate ricalcolata; un orario lavorativo senza fuso, "floating", vale nel fuso
   dell'agente: `$cfg->getTimezone()`), reindicizzazione `_search`.

## Ticket::updateField (ajax editField) — `updateTicketField`
Permesso `ticket.edit`. Valore uguale all'attuale → `already_set` senza scritture.
- **Campi dei form** (`priority` o id del campo): `form_entry_values` + `ticket__cdata`, save del ticket; evento **edited**
  `{"0":vecchio,"1":nuovo,"fields":{"<id>":[vecchio,nuovo]}}` (memo: tag rimossi e troncati a 200 caratteri).
- **topic** (`topic_id`, topic attivo o attuale), **sla** (`sla_id`; un id non valido non cambia nulla ma registra
  l'evento con dati NULL, come il PHP), **source**, **duedate**: colonna + save; evento `{"<colonna>":[vecchio,nuovo]}`.
- Nota `<etichetta> updated` con i commenti, **senza** avvisi.
- `lastupdate = NOW()`; per SLA e scadenza `updateEstDueDate`; save; `_search`.

## Ticket::changeOwner (do=changeuser) — `changeTicketOwner`
`ticket.user_id` (save), cancellazione dell'eventuale collaboratore con quell'utente, evento **edited**
`{"owner":<id>,"fields":{"Ticket Owner":"<nome>"}}`.

## Collaboratori — `addCollaborator`, `updateCollaborators`
- Aggiunta (ajax add-collaborator / do=addcc): il proprietario non può essere collaboratore (`owner`); già presente →
  `already_collaborator`. `INSERT thread_collaborator` (flags `ACTIVE|CC` = 3, role `M`, created/updated NOW);
  evento **collab** `{"add":{"<user_id>":{"name":"<nome>"}}}`.
- Aggiornamento (ajax collaborators): per ogni `del` DELETE + evento **collab** `{"del":{...}}`; `cid` → `updated = NOW()`
  e flag ACTIVE; tutti gli altri collaboratori del thread perdono ACTIVE e ricevono comunque `updated = NOW()`.

## Merge e link — `mergeTickets`, `unlinkTickets`
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

## Eliminazione — `deleteTicket` / `ticketHardDelete`
Collegata a `changeTicketStatus` (stato "deleted", permesso `ticket.delete`) con `{ hardDelete: ticketHardDelete({children}) }`.
Ordine: DELETE ticket + `_search` T; figli di un padre → `ticket_pid NULL`, flag di merge azzerati (save), thread `T`;
per un figlio il padre senza altri figli torna normale e il thread **non** viene eliminato; altrimenti DELETE thread,
`_search` H delle voci, `thread_entry_email.headers = NULL`, allegati H (+ `AttachmentFile::deleteOrphans`: file `T`
senza allegati creati da più di un giorno, con i `file_chunk`), collaboratori, referral, voci, `thread_event.thread_id = 0`;
evento **deleted** sul vecchio thread; DELETE form_entry + risposte; bozze `ticket.%.<id>`; riga `ticket__cdata`;
syslog Debug "Ticket #N deleted" (`<hr>` + commenti, solo con `log_level` 3). Il lock del ticket resta (come il PHP).
Con "anche ai figli" i figli vengono eliminati dopo il padre (controllo `ticket.delete` per figlio).

## Segna scaduto e ban list — `markTicketOverdue`, `setTicketEmailBan`
- Scaduto (solo manager del reparto, ticket aperto): `isoverdue = 1` (save), evento **overdue**, avvisi
  `ticket.overdue` (SLA senza NOALERTS, `overdue_alert_active`; assegnatario/membri del team se
  `overdue_alert_assigned`, altrimenti membri del reparto se non assegnato e `overdue_alert_dept_members`; più il
  manager), poi nota di sistema `Ticket Marked Overdue` / `Ticket flagged as overdue by <agente>` (SYSTEM, senza avvisi).
  Se già scaduto solo la nota.
- Ban (`emails.banlist`): `INSERT filter_rule` (filtro "SYSTEM BAN LIST", `email equal <indirizzo>`, isactive 1,
  notes '', created/updated NOW); unban: DELETE delle regole corrispondenti.

## Azioni di massa — `mass.ts`
Riusano `assignTicket`, `assignToStaff`, `transferTicket`, `setTicketStatus`, `deleteTicket`, `mergeTickets`.
- Assegna (agenti di `Staff::getDeptAgents` filtrati per reparti "solo membri"), presa in carico (Ticket::claim non
  controlla stato e assegnatario: un ticket già assegnato passa all'agente), trasferisci, elimina (ticket.delete in
  almeno un ruolo), cambio stato (`canManageTickets` + permesso per stato in almeno un ruolo; nota "Status Changed"
  con avvisi; "deleted" elimina), merge/link.
- Stranezza replicata: per trasferimento e cambio stato il PHP condivide `$errors` tra i ticket; dopo il primo errore
  di validazione (già nel reparto, non chiudibile) i ticket successivi falliscono senza scritture.

## Modifica di una voce del thread — `editThreadEntry`
Visibile per voci non di sistema (risposte solo di agenti); permesso: voce propria, manager del reparto o
`thread.edit`. Corpo pulito identico → nessuna scrittura. Altrimenti nuova `thread_entry` (pid = voce, stessi
autore/poster/tipo, titolo `htmlchars`, `recipients` **NULL** come il PHP), allegati non inline spostati,
`flags = (base & ~HIDDEN & ~GUARDED) | EDITED`, `editor`/`editor_type 'S'`, `created` della base, `updated NOW`;
la base riceve `HIDDEN`. Una seconda modifica dello stesso agente sostituisce la precedente (DELETE + `_search`).

## Export CSV — `exportQueueCsv`
Campi della coda (`queue_export`, ereditati con `0x80`, oppure gli standard + campi cdata), eventuale selezione;
ticket della coda con visibilità e ordinamento della lista **senza** filtro sui figli dei merge; BOM UTF-8,
`fputcsv` (virgolette solo se il campo contiene separatore, virgolette, spazi o a capo); valori come
`from_query ?: valore grezzo ?: ''` (contatori a 0 vuoti, Yes/No, nomi completi di reparto e topic).
Il PHP prepara il file in background e lo invia per email se non scaricato: qui il download è immediato.

## Differenze volute (permessi) rispetto al PHP
- **Cambio stato di massa**: solo stati abilitati *open*/*closed* (o *deleted*), come nel menu: vedi area "actions", "Solo stati sceglibili".
- **Riapertura di massa**: `setSelectedTicketsStatus` verifica `ticket.close`/`ticket.create` solo "in almeno un ruolo" e
  `Ticket::setStatus` non lo ricontrolla per lo stato *open*: con il permesso nel reparto A si riaprivano i ticket chiusi
  del reparto B accessibile in sola lettura. Qui, come l'azione singola, il permesso si verifica sul ruolo del reparto di
  ciascun ticket e gli altri ticket si saltano (`massChangeStatus`). Il PHP ha lo stesso difetto. Test:
  `ticket-edit-mass` ("riapertura di massa: saltati i ticket…").
- Collaboratori: gli endpoint ajax controllano solo l'accesso al ticket; qui serve `ticket.reply` o `ticket.edit`
  (come la vista). La riattivazione `cid` è limitata ai collaboratori del thread.
- Merge/link: niente scorciatoia "thread con un referral qualsiasi" (`isReferred()`), permessi verificati su tutti i
  ticket prima di scrivere; scollegamento (`dtids`) con `ticket.link` o `ticket.merge` (il PHP non controlla nulla).
- Merge con thread "nipoti" ancora pieni: il PHP chiamerebbe `saveExtra` con argomenti scambiati (errore); qui le
  voci vengono spostate normalmente.

## Altre differenze
- `addMissingFields` avviene al salvataggio invece che all'apertura del form (stesso risultato finale).
- Ban list mancante: il PHP crea il filtro "SYSTEM BAN LIST"; qui l'operazione risponde `no_banlist`.
- Testi "Yes/No" e intestazioni del CSV in inglese come il PHP con lingua di sistema `en_US`.
