# 15 — Guida alla riscrittura da zero (istruzioni operative per un LLM / team)

Questo documento traduce l'analisi (doc 01–14) in un piano implementativo. Stack di riferimento proposto: **PHP 8.3 + Laravel 11/12 (strict_types), PostgreSQL 16, Redis, Docker, GitHub Actions**; frontend **Blade + Livewire 3** (o Inertia + Vue) per pannello agenti e portale. Le scelte sono sostituibili, la **semantica funzionale** no.

## 1. Principi

1. **Parità funzionale prima, miglioramenti dopo**: replicare i comportamenti documentati (in particolare: pipeline di creazione ticket doc 04 §2, filtri §3, visibilità §4, stati §5, assegnazioni §6, matrice notifiche §10, threading email doc 05 §2.4–2.6, SLA/orari doc 04 §8).
2. **Integrità nel DB**: FK reali (vedi `16-schema-postgresql-proposto.sql`), `NULL` invece di `0`, UTC ovunque, `utf8mb4`/UTF-8 completo (niente rimozione emoji).
3. **Domain services espliciti** al posto dei metodi "god object" (`Ticket` 4800 righe).
4. **Eventi di dominio** al posto dei `Signal` (stessi nomi/payload per facilitare plugin e audit).
5. **Policy di autorizzazione centralizzate** (Laravel Policies/Gates) con la stessa logica di ruoli per reparto + permessi globali.
6. **Job asincroni** per email in uscita, fetch, overdue, indicizzazione, export (invece di cron/autocron sincroni).
7. **Compatibilità dati**: script ETL da MySQL osTicket 1.18 (stessi id, conversione 0→NULL, datetime → UTC con il fuso del server MySQL di origine, EAV → jsonb, password bcrypt riusabili, credenziali cifrate da ri-cifrare decifrando con `SECRET_SALT`).

## 2. Moduli (bounded context) e mappatura

| Modulo | Entità | Componenti Laravel |
|---|---|---|
| **Core/Config** | config (namespace/key/value), sequenze, i18n contenuti | `settings` table + `SettingsRepository` con cache; `Sequence` con `SELECT ... FOR UPDATE` |
| **Identity** | Staff, StaffDeptAccess, Role, Team, TeamMember, User, UserEmail, UserAccount, Organization | 2 guard (`staff`, `client`), Fortify/Sanctum, Policies, 2FA (TOTP + email OTP) |
| **Org structure** | Department (albero), HelpTopic (albero), SLA, Schedule/Entries | servizi `BusinessHoursCalculator`, `SlaResolver` |
| **Ticketing** | Ticket, TicketStatus, Priority, Lock, Collaborator, Referral, Merge | `TicketService` (create/update/transfer/assign/refer/claim/release/merge/delete), `TicketStateMachine`, `TicketVisibilityScope` |
| **Thread** | Thread, ThreadEntry (M/R/N + versioni), ThreadEvent, Event, EmailInfo, MergeInfo | `ThreadService`, `EventLogger` (timeline), entry versioning |
| **Tasks** | Task, task thread | `TaskService` |
| **Forms** | Form, FormField, FormEntry, Answer, List, ListItem | form builder; valori in `jsonb` + tabella answers per audit; indici GIN; validatori per tipo |
| **Filters** | Filter, Rule, Action, Banlist | `FilterEngine` (match + azioni pre/post creazione) |
| **Mail** | Email, EmailAccount (IMAP/POP/SMTP, OAuth2), EmailTemplateGroup/Template | `InboundMailProcessor` (webklex/php-imap o MS Graph/Gmail API), `MessageIdCodec`, `OutboundMailer` (Symfony Mailer, header e Message-ID custom), `TemplateRenderer` (variabili `%{}`) |
| **Files** | File, Attachment, Draft | Laravel Storage (S3/disk), dedup per hash, signed URLs (`URL::temporarySignedRoute`) |
| **KB** | FAQ, Category, FaqTopic, Canned, Content/Page | |
| **Queues & Search** | Queue, Column, Sort, Export, QueueConfig | query builder da criteri JSON; Postgres FTS (`tsvector`) o Meilisearch/Elastic; export CSV via job |
| **Reporting** | ThreadEvent aggregati | query SQL/materialized views |
| **API** | ApiKey | Sanctum token con abilities `tickets:create`, `cron:run`; endpoint compatibili `/api/tickets.{json,xml,email}` |
| **Admin** | tutte le configurazioni | CRUD |
| **Plugins/Extensibility** | Plugin, PluginInstance | service provider/package Laravel + eventi; registri per: auth backend, storage, field type, filter action, thread action, permessi, avatar, export |

## 3. Modello dati (raccomandazioni oltre lo schema fedele)

- Partire da `16-schema-postgresql-proposto.sql` (fedele) e poi, se si vuole un modello "pulito":
  - `ticket.subject`, `ticket.priority_id` come **colonne vere** (oggi nel form T): semplifica code, ordinamenti, API. Mantenere i campi custom in `ticket.custom_fields jsonb` (+ tabella `form_entry_values` per storico/compatibilità).
  - Sostituire `*__cdata` con `jsonb` indicizzato (`GIN`), o viste.
  - Sostituire `_search` con colonne `tsvector` generate (`ticket.search_vector`, `thread_entry.search_vector`) + indici GIN, oppure un motore esterno.
  - Polimorfismi: `thread` 1:1 con `ticket`/`task` → `ticket.thread_id`/`task.thread_id` FK; `attachment` → tabelle ponte per tipo o `morphs` Laravel (`attachable_type`, `attachable_id`).
  - Bitmask → colonne booleane esplicite (più leggibili) o mantenere bitmask con helper (scegliere uno e documentarlo; le API esterne devono esporre booleani).
  - `thread_event.data` → `jsonb`.
  - `config` → tabella `settings` tipizzata (key, value jsonb).
  - `session` → driver Redis/database di Laravel.
  - Rimuovere tabella `group` legacy.
- Timestamp `created_at/updated_at` gestiti dal framework; mantenere i campi di dominio (`closed`, `reopened`, `lastupdate`, `duedate`, `est_duedate`).

## 4. Servizi chiave e pseudo-codice

### 4.1 `TicketService::create(CreateTicketData $d, Origin $origin): Ticket`
Seguire **esattamente** l'ordine di doc 04 §2.2 (40 passi). Punti da non perdere:
- validazione per origin (web/staff/api/email) e filtro campi per contesto;
- filtri pre-creazione (con ri-esecuzione su `replyto`), ban list, limite ticket aperti, rifiuto utenti non registrati (con eccezione domini org);
- risoluzione utente/creazione con org per dominio;
- priorità di risoluzione: filtro > email di sistema > help topic > org account manager > default;
- numerazione (sequenza o random univoco; per topic);
- primo messaggio con flag ORIGINAL_MESSAGE, collaboratori (ccs, org), filtri post-creazione (send email);
- SLA (filtro > reparto > topic > default), stato, auto-assegnazione (solo se open), `est_duedate`;
- soppressione auto-risposte (email di sistema, bounce, auto-reply, canned, reparto);
- notifiche `onNewTicket`, `onOpenLimit`, evento `TicketCreated`.
Racchiudere in transazione DB; inviare email via job **dopo commit**.

### 4.2 `TicketVisibilityScope` (Eloquent scope)
Replicare doc 04 §4.2 (assegnato a me/miei team, referral a me/miei team/reparti, reparti primari+estesi, esclusione archived, `assigned_only`), più figli di merge `C`.

### 4.3 `TicketStateMachine`
Stati logici open/closed/archived/deleted; transizioni e side-effect di doc 04 §5 (closeable checks, staff_id=chiusore, clearOverdue, referral auto, annullamento eventi, riapertura con auto-riassegnazione condizionale, ricalcolo SLA).

### 4.4 `BusinessHoursCalculator::addWorkingHours(CarbonImmutable $start, float $hours, Schedule $s): CarbonImmutable`
Replicare doc 04 §8.2 (occorrenze per tipo ricorrenza, festività piene/parziali, backtrack). Scrivere test con lo schedule seed "Mon–Fri 8–17 + US Holidays" e casi limite (inizio fuori orario, a metà giornata, a cavallo di festività, weekend).

### 4.5 `InboundMailProcessor`
- Fetch per mailbox con frequenza, max messaggi, azioni post-fetch, backoff errori (5 errori → pausa 10 min + alert).
- Parsing (MIME, charset, TNEF, inline cid, bounce/DSN, auto-reply).
- Threading: `MessageIdCodec` (formato doc 05 §2.6 — mantenerlo compatibile per non rompere i thread esistenti dopo la migrazione!), lookup per `mid`, `In-Reply-To`, `References`, marker nel corpo, numero ticket nell'oggetto `[#123456]` solo se il mittente è owner/collaboratore.
- Tipo entry: owner/collab → M; agente → **N**; sconosciuto → M con banner; email di sistema → scarta.
- Idempotenza: registrare il Message-ID anche per email rifiutate.

### 4.6 `NotificationService`
Implementare la matrice doc 04 §10 e task doc 07 §1 come classi Notification/Mailable per template, con: destinatari calcolati (membri per alert del reparto, team, manager, last respondent, account manager, admin), esclusione agenti non disponibili/duplicati/autore, header anti-loop (`Auto-Submitted`, `X-Auto-Response-Suppress`, `Precedence`), threading (`In-Reply-To`, `References`), firma, nome mittente, allegati, link tokenizzati.

### 4.7 `TemplateRenderer`
Motore `%{a.b.c}` (doc 05 §5) con blacklist e oggetti con `getVar`. Valutare la migrazione dei template a Blade/Twig mantenendo un parser di compatibilità per i template importati.

### 4.8 `FilterEngine`
Doc 04 §3: selezione per target/email, ordine, match all/any, operatori (case-insensitive, regex), azioni, stop-on-match, eventi descrittivi. Le azioni sono strategie registrabili.

### 4.9 Autorizzazioni
```php
Gate::define('ticket.reply', fn(Staff $s, Ticket $t) => $t->staffCan($s, 'ticket.reply'));
// Ticket::staffCan: canView($s) && roleFor($s, $t->dept, $t->isAssignedTo($s))->has($perm)
```
Permessi globali (`user.*`, `org.*`, `faq.manage`, `emails.banlist`, `search.all`, `stats.agents`, `visibility.*`) come abilities sull'agente; `isAdmin` per l'area admin.

## 5. Scheduler e job (sostituiscono `Cron::run`)
| Job | Frequenza | Origine |
|---|---|---|
| `FetchMailboxes` | ogni minuto (rispetta `fetchfreq` per mailbox) | MailFetcher |
| `MarkOverdueTickets` (+ task) | ogni 5 min, batch | TicketMonitor |
| `ReleaseExpiredLocks` | ogni 5 min | Lock::cleanup |
| `PurgeSyslog` | giornaliero | PurgeLogs |
| `PurgeDrafts` (>14 gg) | giornaliero | PurgeDrafts |
| `DeleteOrphanFiles` (>1 gg) | orario | CleanOrphanedFiles |
| `PurgeExpiredSessions/ResetTokens` | orario | |
| `ReindexSearch` | continuo/queue | IndexOldStuff |
| `SendMail` | queue | invii |
| `QueueExport` | queue | export CSV con notifica |

## 6. API
- Mantenere endpoint compatibili: `POST /api/tickets.json|xml|email` (stessi campi, stessi codici: 201 + numero ticket), `POST /api/tasks/cron` (opzionale).
- Aggiungere API moderne (REST/JSON:API) per ticket (lettura, risposta, nota, stato, assegnazione), utenti, org, con token per agente o service account e scope.
- Webhook in uscita sugli eventi di dominio (utile per integrazioni n8n).

## 7. Frontend
- Portale cliente: home/KB, apertura ticket con form dinamici per topic, login/registrazione/reset, lista e dettaglio ticket con risposta, accesso con email+numero, link tokenizzati.
- Pannello agenti: code con colonne/ordinamenti/contatori/azioni di massa, vista ticket (header azioni, info, form, thread con eventi, risposta/nota con lock, canned, firma, collaboratori), apertura ticket, task, utenti/org, KB, dashboard, profilo.
- Admin: tutte le pagine di doc 13.
- Editor rich text (TipTap/CKEditor) con bozze autosalvate, immagini inline, variabili.

## 8. Migrazione dati (ETL MySQL osTicket → nuovo DB)
1. Leggere `ost-config.php` di origine (prefisso, `SECRET_SALT`).
2. Determinare il fuso orario del MySQL di origine (`SELECT @@system_time_zone, NOW(), UTC_TIMESTAMP()`) e convertire tutti i datetime in UTC.
3. Copiare tabelle in ordine topologico; convertire `0`→`NULL` sulle FK; preservare gli id; reimpostare le sequence.
4. Ticket: estrarre `subject`/`priority` dal form T (o da `ticket__cdata`) se si adottano colonne vere; custom fields → jsonb.
5. File: copiare `file_chunk` (ordinati per `chunk_id`) nello storage, verificare `signature`.
6. Credenziali email: decifrare con `Crypto` originale (AES-128-CBC, chiave derivata da `SECRET_SALT` + subkey `md5(username . namespace)`), ri-cifrare con la nuova chiave.
7. Password: bcrypt compatibile con `password_verify` (Laravel Hash); MD5 legacy → forzare reset.
8. Message-ID: mantenere `SECRET_SALT` originale per decodificare risposte a email inviate prima della migrazione (o un codec di compatibilità).
9. Config `core` → settings; template email/pagine → nuove tabelle.
10. Verifica: conteggi per tabella, campioni di ticket con thread/allegati, ricalcolo `est_duedate`, contatori code.

## 9. Checklist di test di accettazione (comportamenti da preservare)
- [ ] Creazione ticket da web/email/API/staff con tutte le precedenze (reparto, priorità, SLA, topic, assegnazione).
- [ ] Filtri: ogni operatore, all/any, stop-on-match, reject (403 API, nessun ticket), replyto (riesecuzione), canned auto-reply (ticket resta unanswered), send email post-creazione.
- [ ] Ban list blocca ticket e risposte agente all'email bannata.
- [ ] Limite ticket aperti + notice.
- [ ] Utenti non registrati rifiutati da email (eccetto domini org) quando configurato.
- [ ] Numerazione: formato con `#`, `\#` letterale, random univoco, sequenze per topic.
- [ ] Visibilità agente (reparto, esteso, assegnato, team, referral, assigned_only) — matrice di test.
- [ ] Ruolo effettivo per reparto e per assegnatario fuori reparto (def_assn_role).
- [ ] Chiusura bloccata da campi obbligatori / task aperti / topic mancante.
- [ ] Riapertura con riassegnazione condizionale e ricalcolo SLA; risposta del cliente riapre se consentito.
- [ ] Auto-claim su risposta; claim; release; transfer (con rimozione assegnatario non membro, SLA transient, referral di origine); refer.
- [ ] Merge combine/separate (spostamento entries, stati figli, collaboratori, task) e link visual; unlink; cancellazione parent/child.
- [ ] Overdue da cron (duedate vs est_duedate), alert, SLA senza alert.
- [ ] Calcolo SLA con orari e festività (casi limite).
- [ ] Lock: acquisizione, rinnovo, scadenza, rifiuto se altrui, `lockCode`.
- [ ] Matrice notifiche completa (chi riceve cosa in ogni evento, esclusioni).
- [ ] Threading email: risposta del cliente via email → messaggio; risposta dell'agente via email → nota; mittente sconosciuto → banner; loop detection; duplicati; subject `[#num]`.
- [ ] Strip quoted reply e immagini inline.
- [ ] Collaboratori da To/Cc (attivi solo se scrive l'owner), CC nelle risposte, notifiche collaboratori.
- [ ] Portale: accesso guest via email+numero, link tokenizzati, condivisione org.
- [ ] Code: criteri, colonne, ordinamenti, contatori, export asincrono.
- [ ] Permessi globali e di ruolo su tutte le azioni (incluso IDOR sugli endpoint AJAX equivalenti).
- [ ] Sessioni: idle timeout, binding IP, rigenerazione ID, invalidazione al cambio password, 2FA.
- [ ] i18n: lingua da preferenza/sessione/browser, traduzioni contenuti, template per lingua.

## 10. Ordine di implementazione consigliato (milestone)
1. Schema + ETL + modelli + seed (doc 02, 16).
2. Identity: agenti, ruoli, reparti, team, permessi, login/2FA, utenti/org.
3. Ticket core: creazione (staff/web), vista, thread (M/R/N), stati, assegnazioni, lock, eventi.
4. Form dinamici e liste.
5. Email in uscita (template, notifiche).
6. Email in ingresso (fetch, parsing, threading).
7. Filtri, SLA/orari, overdue.
8. Code/ricerca/export, dashboard.
9. Task, KB, canned, pagine.
10. API, merge/link, referral, collaboratori avanzati, i18n contenuti.
11. Admin completo, plugin/estensioni, hardening sicurezza (doc 14).
