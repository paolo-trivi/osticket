# Contratto di scrittura — azioni sul ticket di un agente (M2.3 parte A)

Verificato con `test/diff/ticket-actions.diff.test.ts`: 33 scenari, righe DB ed email identiche al PHP
(operazioni PHP in `test/diff/php/ops/actions.php`, che ripercorrono `include/ajax.tickets.php`).

Servizi: `src/server/domain/ticket/assign.ts` (assegnazione, claim, rilascio, referral),
`transfer.ts` (trasferimento), `ticket-state.ts` (cambio stato da menu, riapertura, segna risposto),
`alerts.ts` (destinatari e invio degli avvisi agli agenti). Server action:
`src/app/[locale]/(staff)/agent/(panel)/tickets/[id]/actions-assign.ts`.

Convenzioni comuni:
- ogni `Ticket::save` passa da `TicketRecord` (solo campi cambiati + `updated = NOW()` + reindicizzazione `_search` T);
- gli eventi passano da `logTicketEvent` (`thread_event.staff_id` = assegnatario dopo la modifica, o l'agente se non assegnato);
- i commenti dei form sono HTML passato per `Format::sanitize` (TextareaField html); "vuoto" = solo tag/spazi;
- le note sono `thread_entry` di tipo `N` create con `postNote` (autore l'agente, formato html, indice `_search` H).

## Assegnazione (`assignTicket`) — ajax `assign` + `Ticket::assign`
Permessi: `ticket.assign` sul ticket (checkStaffPerm). Validazione del form: l'assegnatario `s<id>` deve essere tra
gli agenti di `Dept::getAssignees` (disponibili; solo membri/primari con i flag `0x1`/`0x10`; limitati da
`applyDeptVisibility` se l'assegnatore non ha `visibility.agents`), `t<id>` tra i team attivi
(`Team::getActiveTeams`), team abilitato e con membri.

Ordine delle scritture:
1. agente: errore se già assegnato, non disponibile o `Dept::canAssign` fallisce; altrimenti cancellazione del
   referral `S` del nuovo assegnatario. Team: errore se già assegnato; cancellazione del referral `E` del team.
2. `ticket.staff_id` (o `team_id`) + `updated` (save).
3. `thread_event` **assigned**: `{"staff":[id,"Nome Cognome"]}` (nome originale `first last`),
   `{"claim":true}` se l'agente assegna sé stesso (nessun avviso), `{"team":id}`.
4. `onAssign`: se chiuso → `Ticket::reopen` (stato di riapertura o `default_ticket_status_id`, via `setStatus`);
   nota con i commenti, titolo `Ticket Assigned to <nome>` o `Ticket claimed by <agente>`, senza avvisi.
5. Avviso `assigned.alert` se `assigned_alert_active` e il reparto ha membri per gli avvisi:
   - agente: a lui se `assigned_alert_staff`; team (senza flag NOALERTS `0x2`): membri con flag avvisi
     se `assigned_alert_team_members`, altrimenti il capo team se `assigned_alert_team_lead`;
   - email del reparto (`department.email_id`, altrimenti `default_email_id`), template del reparto;
   - variabili `%{assignee}`, `%{assigner}`, `%{comments}` (HTML dei commenti), poi `%{recipient}` (seconda sostituzione);
   - Message-ID legato alla nota se presente; header di avviso (`Auto-Submitted`).
6. Se richiesto `refer`: `thread_referral` al precedente agente (`S`) o team (`E`) se non già presente.

## Presa in carico (`claimTicket`) — ajax `claim` + `Ticket::claim` + `assignToStaff`
Permessi: `ticket.assign`, ticket aperto, nessun agente assegnato; agente disponibile e `Dept::canAssign`.
`staff_id` (save) → `onAssign` senza avvisi (nota `Ticket claimed by …` se commenti) → evento **assigned**
`{"claim":true}` → cancellazione del referral `S` dell'agente.
`assignToStaff`/`assignToTeam` sono esportati anche per usi di sistema (dati evento `{"staff":id}` / `{"team":id}`;
`assignToTeam` azzera `staff_id` sui ticket chiusi).

## Rilascio (`releaseTicket`) — ajax `release` + `Ticket::release`
Permessi: `ticket.release` oppure manager del reparto del ticket (vedi differenze). Solo ticket assegnati.
- agente e team: `unassign` → due salvataggi separati (`staff_id = 0`, poi `team_id = 0`);
- solo agente / solo team: un salvataggio;
- evento **released** con `{"staff":[id,"Nome Cognome"]}` e/o `{"team":id}` per ciò che è stato rilasciato;
- nota `Assignment Released` con i commenti (senza avvisi).

## Trasferimento (`transferTicket`) — ajax `transfer` + `Ticket::transfer`
Permessi: `ticket.transfer`. Reparto tra quelli proposti da `DepartmentField` (attivi; solo quelli accessibili senza
`visibility.departments`), diverso dall'attuale.
1. `dept_id`; `staff_id = 0` se il ticket è assegnato e il nuovo reparto ha `ASSIGN_MEMBERS_ONLY` e l'agente non ne
   è membro; save.
2. Se chiuso: `Ticket::reopen` (riassegnazione all'ultimo agente se ha accesso al nuovo reparto,
   `reopened`, evento **reopened** che annulla i **closed**, `est_duedate` ricalcolata con lo SLA ancora attuale).
3. SLA: se il ticket non ha SLA o il suo è *transient* (`0x8`) e il nuovo reparto ne ha uno → `sla_id` (save).
   `est_duedate` **non** viene ricalcolata (comportamento PHP).
4. Evento **transferred** `{"dept":"<nome reparto>"}`; cancellazione del referral `D` al nuovo reparto.
5. Nota `Ticket transferred from <vecchio> to <nuovo>` con i commenti (senza avvisi).
6. Se `refer`: referral `D` al reparto precedente.
7. Avviso `transfer.alert` se `transfer_alert_active` e il nuovo reparto ha membri per gli avvisi: assegnatario
   (agente, oppure membri del team con flag avvisi) se `transfer_alert_assigned` e il ticket è assegnato; altrimenti i
   membri del reparto (`transfer_alert_dept_members`); più il manager (`transfer_alert_dept_manager`).
   `%{comments}` è la nota (vuota se assente), `%{staff}` l'agente.

## Referral (`referTicket`) — ajax `refer` (do=refer) + `Ticket::refer`
Permessi: `ticket.assign` e `ticket.refer` (vedi differenze). Scelte: agenti attivi di altri reparti, team attivi,
reparti attivi visibili. Errori: agente già assegnatario/non disponibile, team già assegnato, ticket già nel reparto,
referral già presente.
`thread_referral` (`S`/`E`/`D`, `created = NOW()`) → evento **referred** `{"staff":[id,"Nome"]}` / `{"team":id}` /
`{"dept":id}` → nota `Referral` con i commenti, **con** avvisi `note.alert` (logNote).

## Cambio stato da menu (`changeTicketStatus`) — ajax `setTicketStatus`
Permessi: stato *open* → `ticket.close` o `ticket.create`; *closed* → `ticket.close`; *deleted* non gestito qui
(eliminazione: area "ticketedit"). Poi `setTicketStatus` (status.ts) con i commenti: nota `Status Changed` con avvisi,
eventi **closed**/**reopened**/**edited**, referral all'agente con `auto_refer_closed`, riapertura con riassegnazione e
nuova `est_duedate`. Con `children` lo stesso stato ai figli (solo se il ticket ha `FLAG_PARENT 0x10`, figli per
`sort`); i figli non modificabili sono restituiti in `warn`.

## Segna risposto / non risposto (`markTicketAnswered`) — ajax `markAs`
Permessi: `ticket.markanswered` oppure manager del reparto del ticket. Errore se già nello stato richiesto.
`isanswered` (save) → nota con i commenti (titolo `Ticket Marked Answered|Unanswered`, senza avvisi) → nota di sistema
`logActivity`: stesso titolo, corpo `Ticket flagged as answered by <agente>`, `staff_id = 0`, `poster = SYSTEM`,
flag `SYSTEM|BALANCED`, nessuna riga `_search` H. Nessun `thread_event`.

## Differenze volute rispetto al PHP
- **Rilascio**: il PHP accetta, oltre a `ticket.release`, il manager del reparto *primario* dell'agente
  (`Staff::isManager()` senza argomenti). Si applica la regola più stretta: manager del reparto del ticket
  (la stessa che mostra la voce nella vista).
- **Rilascio di un ticket non assegnato**: il PHP imposta l'errore ma esegue comunque il rilascio (azzerando ad es. l'agente
  di chiusura di un ticket chiuso e registrando un evento vuoto). Qui l'operazione è rifiutata (`not_assigned`); la UI
  del PHP non la propone.
- **Referral**: il PHP mostra la voce con `ticket.refer` ma l'endpoint controlla `ticket.assign`; si richiedono entrambi.
- Lo stato "deleted" dal menu stati non è gestito (eliminazione definitiva dell'area "ticketedit").
