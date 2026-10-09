# Contratto di scrittura — azioni sul ticket di un agente (M2.3 parte A)

Verificato con `test/diff/ticket-actions.diff.test.ts`: **47 scenari**, righe DB ed email identiche al PHP
(operazioni PHP in `test/diff/php/ops/actions.php`, che ripercorrono `include/ajax.tickets.php`).

```
OST_DIFF_TAG=actions MAILPIT_SMTP_PORT=1026 MAILPIT_HTTP_PORT=8026 \
  npx vitest run -c vitest.diff.config.mts test/diff/ticket-actions.diff.test.ts
```

## File
| Livello | File | Contenuto |
|---|---|---|
| Dominio | `src/server/domain/ticket/assign.ts` | assegnazione, presa in carico, rilascio, referral, rimozione referral, scelte dei form |
| Dominio | `src/server/domain/ticket/transfer.ts` | trasferimento di reparto |
| Dominio | `src/server/domain/ticket/ticket-state.ts` | cambio stato da menu, riapertura, segna risposto, stati del menu, avviso `isCloseable`, aggancio "deleted" |
| Dominio | `src/server/domain/ticket/alerts.ts` | destinatari e invio degli avvisi agli agenti |
| Server action | `src/app/[locale]/(staff)/agent/(panel)/tickets/[id]/actions-assign.ts` | `assignAction`, `claimAction`, `releaseAction`, `transferAction`, `referAction`, `removeReferralsAction`, `statusAction`, `markAction` |
| UI | `src/components/tickets/TicketActionsMenu.tsx` (server) + `src/components/tickets/actions/*` (client) | barra azioni della vista ticket e modali |
| Testi | `src/messages/actions/{it,en}.json` | namespace `ticketActions` |

## Convenzioni comuni
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

## Assegnazione (`assignTicket`) — ajax `assign` + `AssignmentForm` + `Ticket::assign`
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

## Presa in carico (`claimTicket`) — ajax `claim` + `Ticket::claim` + `assignToStaff`
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

## Rilascio (`releaseTicket`) — ajax `release` + `Ticket::release`
Permessi: `ticket.release` oppure manager del reparto del ticket (vedi differenze). Solo ticket assegnati, con almeno una casella scelta.
- **Agente e team** (`unassign`): due salvataggi separati, prima `staff_id = 0` e poi `team_id = 0`.
- **Solo agente** / **solo team**: un solo salvataggio.
- Evento **released** con `{"staff":[id,"Nome Cognome"]}` e/o `{"team":id}` per ciò che è stato rilasciato.
- Nota `Assignment Released` con i commenti (senza avvisi).

## Trasferimento (`transferTicket`) — ajax `transfer` + `TransferForm` + `Ticket::transfer`
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

## Referral (`referTicket`) — ajax `refer` (`do=refer`) + `ReferralForm` + `Ticket::refer`
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

## Rimozione dei referral (`removeReferrals`) — ajax `refer` (`do=manage`)
Permessi: come il referral.

Scrittura: `$thread->referrals->filter(['id__in' => $remove])->delete()`, cioè una sola
`DELETE FROM thread_referral WHERE thread_id = <thread del ticket> AND id IN (...)`.
- Gli id di altri thread vengono ignorati.
- Nessun evento, nessuna nota (nel PHP c'è un `TODO: log removal`), il ticket non viene toccato.
- Restituisce il numero di righe rimosse (`removed`), mostrato come "Rimossi N referral".

## Cambio stato da menu (`changeTicketStatus`) — ajax `setTicketStatus`
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

### Riapertura (`Ticket::reopen` / ramo *open* di `Ticket::setStatus`)
- Si applica se il ticket è chiuso e `isReopenable`: stato con `allowreopen` + `reopenstatus`, reparto e help topic non archiviati (`Topic::FLAG_ARCHIVED = 0x4`).
- Riassegnazione all'agente di chiusura, o al penultimo che ha risposto (`getLastRespondent`), se:
  - è disponibile;
  - ha accesso al reparto (`Staff::canAccessDept`);
  - il reparto non ha `DISABLE_REOPEN_AUTO_ASSIGN`.

  Altrimenti `staff_id = 0` (save separato).
- `closed = NULL`, `lastupdate = reopened = NOW()`, `isanswered = 0`, nuovo `status_id`.
- Evento **reopened** (annulla i **closed**); `est_duedate` ricalcolata con lo SLA attuale.
- `Ticket::reopen` (da assegnazione o trasferimento) usa lo stato di riapertura dello stato attuale se di tipo *open*, altrimenti `default_ticket_status_id`.

### Aggancio "deleted" (area ticketedit)
`changeTicketStatus(ctx, input, { hardDelete })` accetta un `TicketHardDelete = (ctx, rec, comments) => Promise<boolean>`
(= `Ticket::delete($comments)`), passato a `setTicketStatus` per il ticket e per ogni figlio (commento vuoto).
- Senza aggancio la richiesta è rifiutata con `not_supported`, senza scritture.
- Il punto da collegare è `statusAction` in `actions-assign.ts` (commento `AGGANCIO "ticketedit"`).
- La voce "Elimina ticket" (`PERM_DELETE`, menu "Altro" del PHP) è dello slot `TicketExtraActions`.

## Segna risposto / non risposto (`markTicketAnswered`) — ajax `markAs`
Permessi: `ticket.markanswered` oppure manager del reparto del ticket. Errore se il ticket è già nello stato richiesto.

Scritture, in ordine:
1. `isanswered` (save);
2. nota con i commenti, titolo `Ticket Marked Answered|Unanswered`, senza avvisi;
3. nota di sistema `logActivity`:
   - stesso titolo, corpo `Ticket flagged as answered by <agente>`;
   - `staff_id = 0`, `poster = SYSTEM`, flag `SYSTEM|BALANCED`;
   - nessuna riga `_search` H.

Non viene registrato nessun `thread_event`.

## UI (vista ticket)
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

## Differenze volute rispetto al PHP
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

## Stranezze PHP replicate (annotate nel codice)
- `est_duedate` non ricalcolata quando il trasferimento cambia lo SLA.
- Due salvataggi separati (e due `updated`) nel rilascio di agente e team.
- Evento **assigned** con il nome *originale* `first last` anche se il formato dei nomi è diverso.
- `Ticket::getLastRespondent` usa la *penultima* risposta di un agente (`LIMIT 1,1`).
- `deleteDrafts` usa una LIKE in cui il `%` del namespace è escapato.
- `markAs`: in caso di errore di `markUnAnswered()` il PHP scrive `$errors['err'] - __(...)` (sottrazione invece di
  assegnazione), quindi l'errore non viene impostato. Il caso non è raggiungibile con un ticket valido.
