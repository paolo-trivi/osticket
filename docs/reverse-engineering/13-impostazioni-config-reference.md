# 13 — Riferimento impostazioni (`config` namespace `core`) e oggetti di amministrazione

Valori di default: **seed** = `include/i18n/en_US/config.yaml` (installazione nuova); **codice** = `OsticketConfig::$defaults` (se la chiave manca nel DB). Booleani = `0/1`.

## 1. Settings → System (`settings.php?t=system`)
| Chiave | Default | Significato |
|---|---|---|
| `isonline` | 1 | Helpdesk online; 0 = portale clienti offline (pagina offline) e solo admin nel pannello |
| `helpdesk_url` | (installer) | URL base (usato in link email, `%{url}`) |
| `helpdesk_title` | (installer) | Titolo |
| `default_dept_id` | (installer) | Reparto di default |
| `force_https` | `''` | `on` = redirect a HTTPS |
| `max_page_size` | 25 | Righe per pagina di default |
| `log_level` | 2 | 1 Error, 2 Warning, 3 Debug |
| `log_graceperiod` | 12 | Mesi di conservazione syslog |
| `default_storage_bk` | `D` | Backend di storage file |
| `max_file_size` | `upload_max_filesize` | Dimensione max upload (byte) |
| `autolock_minutes` | 3 | Durata lock ticket |
| `enable_avatars` | 1 | Mostra avatar |
| `enable_richtext` | 1 | Editor HTML; 0 = solo testo |
| `files_req_auth` | 1 | Download allegati richiede login (eccetto FAQ/pagine) |
| `allow_iframes` | — | Origini consentite per il framing (CSP `frame-ancestors`; default `'self'`); se valorizzato il cookie di sessione usa `SameSite=None` (altrimenti `Strict`) |
| `embedded_domain_whitelist` | youtube.com, dailymotion.com, vimeo.com, player.vimeo.com, web.microsoftstream.com | Domini ammessi per `<iframe>` incorporati nei contenuti HTML (sanitizzazione) |
| `acl` | — | Lista IP consentiti (CSV, match esatto) |
| `acl_backend` | 0 | 0 disabilitato, 1 tutti, 2 solo portale cliente, 3 solo pannello staff (l'admin non può escludere il proprio IP) |
| `date_formats` | — | `''` (da locale), `24` (forza 24h), `custom` |
| `time_format` | `hh:mm a` | Formato ICU (se custom) |
| `date_format` | `MM/dd/y` | |
| `datetime_format` | `MM/dd/y h:mm a` | |
| `daydatetime_format` | `EEE, MMM d y h:mm a` | |
| `default_timezone` | (installer) | Fuso di sistema |
| `default_locale` | — | Locale formati |
| `schedule_id` | (installer: 1) | Orario lavorativo di sistema (fallback SLA) |
| `system_language` | `en_US` | Lingua primaria |
| `secondary_langs` | — | Lingue secondarie (CSV) |
| `enable_daylight_saving` | 0 | legacy |
| `db_timezone` | (sessione) | fuso del DB rilevato (persistito solo in sessione) |
| `schema_signature` | (installer) | versione schema |

## 2. Settings → Company (`t=pages`)
`landing_page_id`, `offline_page_id`, `thank-you_page_id` (pagine `content`), `client_logo_id`, `staff_logo_id` (file `ft=L`), `staff_backdrop_id` (file `ft=B`), dati azienda (form tipo C: nome, sito, telefono, indirizzo).

## 3. Settings → Tickets (`t=tickets`)
| Chiave | Default | Significato |
|---|---|---|
| `ticket_number_format` | `######` | Formato numero (almeno un `#`) |
| `ticket_sequence_id` | 0 | Sequenza (0 = casuale) |
| `queue_bucket_counts` | 0 | Contatore sulle tab di primo livello delle code |
| `default_ticket_status_id` | 1 | Stato iniziale |
| `default_priority_id` | 2 | Priorità di default |
| `default_sla_id` | (installer) | SLA di default |
| `default_help_topic` | 0 | Topic di default (deve essere attivo) |
| `help_topic_sort_mode` | `a` | `a` alfabetico, `m` manuale |
| `max_open_tickets` | 0 | Max ticket aperti per utente (0 = illimitato) |
| `enable_captcha` | 0 | CAPTCHA per guest (richiede GD) |
| `auto_claim_tickets` | 1 | Auto-assegna all'agente che risponde per primo |
| `auto_refer_closed` | 1 | Mantieni referral all'assegnatario alla chiusura |
| `collaborator_ticket_visibility` | 1 | I collaboratori vedono il ticket nel portale |
| `require_topic_to_close` | 0 | Topic obbligatorio per chiudere |
| `allow_external_images` | 0 | Consenti immagini remote nei messaggi |
| `ticket_lock` | 2 | 0 off, 1 on view, 2 on activity |
| `default_ticket_queue` | 1 | Coda di default |
| `show_related_tickets`, `allow_client_updates`, `show_assigned_tickets`, `show_answered_tickets` | — | chiavi legacy salvate ma **non usate** dalla logica 1.18 |
| Autoresponder | | vedi §6 |
| Alerts | | vedi §7 |
| Queues (tab) | | ordinamento/gestione code di sistema (doc 08) |

## 4. Settings → Tasks (`t=tasks`)
`task_number_format` (`#`), `task_sequence_id` (2), `default_task_priority_id`, `default_task_sla_id` (non usato), `task_alert_active/admin/dept_manager/dept_members`, `task_activity_alert_active/laststaff/assigned/dept_manager`, `task_assignment_alert_active/staff/team_lead/team_members`, `task_transfer_alert_active/assigned/dept_manager/dept_members`, `task_overdue_alert_active/assigned/dept_manager/dept_members` (overdue task non implementato).

## 5. Settings → Agents / Users
| Chiave | Default | Significato |
|---|---|---|
| `agent_name_format` | `full` | Formato nome agenti |
| `agent_avatar` | `gravatar.mm` | Sorgente avatar agenti |
| `agent_passwd_policy` | — | Policy password agenti (id plugin) |
| `allow_pw_reset` | 1 | Reset password agenti via email |
| `pw_reset_window` | 30 | Validità token reset (minuti) |
| `passwd_reset_period` | 0 | Scadenza password (mesi) |
| `staff_max_logins` | 4 | Tentativi prima del blocco |
| `staff_login_timeout` | 2 | Minuti di blocco |
| `staff_session_timeout` | 30 | Minuti di inattività (0 = mai) |
| `staff_ip_binding` | 0 | Sessione legata all'IP |
| `require_agent_2fa` | 0 | 2FA obbligatoria |
| `hide_staff_name` | 0 | Nasconde il nome agente ai clienti |
| `disable_agent_collabs` | 0 | Impedisce di aggiungere agenti come collaboratori |
| `client_name_format` | `original` | Formato nome utenti |
| `client_avatar` | `gravatar.mm` | Avatar utenti |
| `client_passwd_policy` | — | Policy password utenti |
| `client_max_logins` | 4 | |
| `client_login_timeout` | 2 | |
| `client_session_timeout` | 30 | |
| `clients_only` | 0 | Login richiesto per aprire ticket |
| `client_registration` | `public` (seed) / `closed` (codice) | `disabled`, `public`, `closed`(private), `auto` |
| `client_verify_email` | 1 | Verifica email (registrazione, access link) |
| `allow_auth_tokens` | 1 | Link tokenizzati nelle email |

## 6. Autoresponder (dentro Tickets)
`ticket_autoresponder` (0 seed) nuovo ticket; `message_autoresponder` (0) nuovo messaggio; `message_autoresponder_collabs` (1) notifica collaboratori; `ticket_notice_active` (1) notice per ticket aperti da agenti; `overlimit_notice_active` (0) notice limite ticket.

## 7. Alerts (dentro Tickets)
| Gruppo | Chiavi (seed) |
|---|---|
| Nuovo ticket | `ticket_alert_active`(1), `ticket_alert_admin`(1), `ticket_alert_dept_manager`(1), `ticket_alert_dept_members`(0), `ticket_alert_acct_manager` |
| Nuovo messaggio | `message_alert_active`(1), `message_alert_laststaff`(1), `message_alert_assigned`(1), `message_alert_dept_manager`(0), `message_alert_acct_manager` |
| Nota interna / attività | `note_alert_active`(0), `note_alert_laststaff`(1), `note_alert_assigned`(1), `note_alert_dept_manager`(0) |
| Assegnazione | `assigned_alert_active`(1), `assigned_alert_staff`(1), `assigned_alert_team_lead`(0), `assigned_alert_team_members`(0) |
| Trasferimento | `transfer_alert_active`(0), `transfer_alert_assigned`(0), `transfer_alert_dept_manager`(1), `transfer_alert_dept_members`(0) |
| Overdue | `overdue_alert_active`(1), `overdue_alert_assigned`(1), `overdue_alert_dept_manager`(1), `overdue_alert_dept_members`(0) |
| Sistema | `send_sys_errors`(1, sempre on), `send_sql_errors`(1), `send_login_errors`(1) |
Validazione: se un gruppo è attivo deve avere almeno un destinatario selezionato.

## 8. Emails → Settings (`emailsettings.php`)
| Chiave | Default | Significato |
|---|---|---|
| `default_email_id` | (installer) | Email di sistema predefinita (mittente) |
| `alert_email_id` | (installer) | Email per alert di sistema (`alertAdmin`, 2FA) |
| `default_smtp_id` | 0 | Account SMTP di default (MTA) |
| `admin_email` | (installer) | Email amministratore (non può essere un'email di sistema) |
| `default_template_id` | (installer) | Gruppo template default |
| `verify_email_addrs` | 1 | Verifica record MX dei domini email inseriti |
| `enable_mail_polling` | 0 | Abilita fetch IMAP/POP |
| `enable_auto_cron` | 0 | Fetch anche da autocron |
| `strip_quoted_reply` | 1 | Taglia testo citato |
| `reply_separator` | `-- reply above this line --` | Separatore |
| `use_email_priority` | 0 | Usa priorità dall'header email |
| `accept_unregistered_email` | 1 | Accetta email da mittenti sconosciuti |
| `add_email_collabs` | 1 | Aggiunge To/Cc come collaboratori |
| `email_attachments` | 1 | Allega file alle notifiche |
| `save_email_headers` | 1 | Salva header grezzi |

## 9. Settings → Knowledgebase
`enable_kb` (0), `restrict_kb` (0: KB visibile anche ai guest), `enable_premade` (1: canned responses).

## 10. Altri namespace
- `staff.<id>`: preferenze agente + config 2FA (doc 09).
- `pwreset`: token reset/confirm.
- `email.<eid>.account.<aid>`: credenziali cifrate (basic: `username`, `passwd`; OAuth2: `client_id`, `client_secret`, `access_token`, `refresh_token`, `expires`, `resource_owner_email`, `strict_matching`…).
- `plugin.<pid>.instance.<iid>`: config istanze plugin.
- `schedule.<id>`: `holidays` (JSON id).
- `mysqlsearch`: `reindex`.
- `<stream>`: `schema_signature`.

## 11. Oggetti di amministrazione ("Manage")

| Oggetto | Campi principali (oltre al DB, doc 02) | Regole |
|---|---|---|
| **Help Topic** (`helptopics.php`) | Nome, padre, stato (Active/Disabled/Archived), tipo (pubblico/privato), note; New ticket options: stato iniziale, reparto, priorità, SLA, thank-you page, auto-assign (agente o team), disabilita auto-risposta; Forms (form aggiuntivi ordinati, campi disattivabili per topic); numerazione custom (sequenza + formato) | non eliminabile se default; disattivazione marca i filtri; ordinamento manuale |
| **Filter** (`filters.php`) | Nome, ordine esecuzione, stato, target (Any/Web/Email/API) + email specifica, stop on match, logica regole (all/any), regole (campo, operatore, valore), azioni ordinate (doc 04 §3) | "SYSTEM BAN LIST" gestita dalla Banlist |
| **SLA** (`slas.php`) | Nome, schedule, grace period (ore), stato, transient, disabilita alert overdue, note | non eliminabile se default |
| **Schedule** (`schedules.php`) | Nome, tipo (business hours / holidays), timezone, holidays associati, voci (nome, ripetizione, giorni/settimana/mese, ora inizio/fine, date validità); clone; diagnostica (simula aggiunta ore) | |
| **API Key** (`apikeys.php`) | IP, stato, can create tickets, can exec cron, note; chiave generata | |
| **Page** (`pages.php`) | Nome, tipo, stato, corpo HTML, note, traduzioni | pagine in uso non eliminabili |
| **Form** (`forms.php`) | doc 06 | |
| **List** (`lists.php`) | doc 06 | |
| **Plugin** (`plugins.php`) | installa da `include/plugins`, abilita/disabilita, istanze e loro configurazione | |
| **Email** (`emails.php`) | Indirizzo, nome, nuovi ticket: reparto, priorità, topic, auto-risposta; **Remote Mailbox** (host, porta, protocollo IMAP/POP, crittografia, auth basic/OAuth2, cartella, frequenza, max per fetch, dopo fetch: archive/delete/nothing, cartella archivio, attivo); **SMTP** (host, porta, auth: come mailbox / nessuna / basic / OAuth2, allow spoofing, attivo) | non eliminabili default/alert email |
| **Banlist** (`banlist.php`) | indirizzi email bannati (regole del filtro di sistema) | permesso `emails.banlist` per agenti |
| **Email Template** (`templates.php`) | gruppi (nome, lingua, stato, note) e template (oggetto, corpo, anteprima variabili) | |
| **Agents/Teams/Roles/Departments** | doc 09 | |
