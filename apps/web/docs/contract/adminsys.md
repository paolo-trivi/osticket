# Contratto di scrittura — area "adminsys" (M5 parte B)

Amministrazione di sistema: email, ban list, template, diagnostica, filtri, form, liste, pagine, code,
API key, log, plugin, informazioni di sistema. Solo amministratori: `requireAdmin(locale)` in ogni
pagina, `requireAdminAction()` (sessione + `isadmin`) in ogni server action. Scritture in transazione
(`adminWrite`). Servizi in `src/server/domain/adminsys/*`, verificati con i test differenziali
`test/diff/adminsys-*.diff.test.ts` (op PHP in `test/diff/php/ops/adminsys.php`).

Convenzioni comuni:
- `Format::sanitize` → `sanitizeHtml` (`adminsys/sanitize.ts`): `sanitizeText` + attributi obbligatori di
  htmLawed (`<img>` senza alt → `alt="image"`, senza src → `src="src"`, `<bdo>` → `dir="ltr"`).
- Modelli ORM con `OrmRow` dell'area admin: INSERT con i soli campi "dirty" (confronto debole PHP),
  UPDATE dei soli campi cambiati, `updated = NOW()` se il modello lo prevede.
- `db_affected_rows()` di mysqli conta le righe cambiate: i conteggi delle azioni di massa con UPDATE
  diretto si calcolano sulle righe che cambiano davvero.
- Nessun DDL (vedi Form).

## Impostazioni email — `/admin/settings/emails` (scp/emailsettings.php)
`updateEmailsSettings(tx, vars)` = `OsticketConfig::updateEmailsSettings`.
- Validazione: `default_template_id`, `default_email_id`, `alert_email_id` (int obbligatori),
  `admin_email` (email obbligatoria, non può essere un'email di sistema), `reply_separator` obbligatorio
  se `strip_quoted_reply`.
- `config` (namespace `core`) con `Config::update`: UPDATE `value`, `updated=NOW()` solo se il valore
  cambia; INSERT se la chiave manca (`verify_email_addrs`, `accept_unregistered_email`,
  `add_email_collabs` nella fixture). Chiavi: default_template_id, default_email_id, alert_email_id,
  default_smtp_id, admin_email, reply_separator; flag 1/0 (isset): verify_email_addrs, enable_auto_cron,
  enable_mail_polling, strip_quoted_reply, use_email_priority, accept_unregistered_email,
  add_email_collabs, email_attachments.

## Account email — `/admin/emails` (scp/emails.php, ajax.email.php)
`saveEmail(tx, id|null, vars)` = `Email::update` / `Email::create`.
- `email`: `email` (sanitize), `name` (striptags), `dept_id`, `priority_id`, `topic_id`, `noautoresp`,
  `notes` (sanitize); nuova: `created=NOW()`; `updated=NOW()` se cambia qualcosa.
- Email esistente: `email_account` mailbox e smtp creati se mancanti (`created`, `type`, `updated`,
  `email_id`) e salvati da `setInfo` se valido (active, host, port, protocol, auth_bk, folder,
  fetchfreq, fetchmax, postfetch, archivefolder / allow_spoofing, protocol=SMTP; azzera
  last_activity, last_error_msg, num_errors). La mailbox viene salvata anche se poi l'SMTP fallisce.
- Account attivo con credenziali: connessione di prova (IMAP/POP3 login e cartelle, SMTP con
  nodemailer `verify`) → errori `mailbox_auth`/`smtp_auth` senza scritture.
- Credenziale con tipo sconosciuto: `logActivity` (num_errors+1, last_error_msg, last_error=NOW()).
- `saveBasicAuth(tx, id, type, {username, passwd}, stash)` = `saveAuth('basic')`: verifica la
  connessione, poi `config` namespace `email.<eid>.account.<aid>`: `username`, `passwd` =
  `Crypto::encrypt(pw, SECRET_SALT, md5(username . namespace))`; account `auth_bk='basic'` + host/porta/
  protocollo dello stash, `updated=NOW()` (INSERT se l'account non esisteva).
  - Bug PHP replicati: account non salvato → namespace `account.0`; SMTP con `auth_bk` salvato
    "mailbox" → credenziali scritte nel namespace della mailbox (cifrate con quello SMTP).
- `massDeleteEmails`: non l'email predefinita né quella degli avvisi; DELETE `email`, `config` dei due
  account, `email_account`; `department.email_id` → email predefinita, `autoresp_email_id` → 0.
  **Differenza**: se un'azione di filtro "email" usa l'indirizzo come `from` il PHP va in errore fatale
  dopo la DELETE (dati orfani): Next rifiuta l'eliminazione (`referenced_by_filter`).
- OAuth2 non gestito (`oauth_unsupported`).

## Ban list — `/admin/banlist` (scp/banlist.php)
Filtro `SYSTEM BAN LIST` (se manca: errore `no_banlist`, la creazione resta al PHP).
- Aggiunta: `filter_rule` (filter_id, what=email, how=equal, val trim, isactive, notes sanitize,
  created=NOW(), updated=NOW()); duplicati rifiutati. Indirizzo validato con `Validator::is_email`
  (`forms/validator.ts`, port di `Mail_RFC822`: accetta ad es. `user@intranet` e `Nome <a@b.com>`).
- Modifica: `FilterRule::update` (val, isactive int (default 1), notes) con `updated=NOW()` se cambia.
- Massa: enable/disable con `UPDATE … SET isactive` (senza `updated`); delete per id del filtro.

## Template — `/admin/templates` (scp/templates.php)
- Set nuovo: INSERT `email_template_group` (created, updated, name striptags, isactive, notes
  sanitize, lang); clonazione: INSERT…SELECT dei messaggi del set sorgente (created/updated NOW).
- Set modificato: UPDATE sempre con `updated=NOW()`; set in uso (reparti o predefinito) non
  disattivabile.
- Massa: enable (UPDATE isactive=1), disable (`updated=NOW(), isactive=0`, non se in uso), delete (non
  se in uso: set, `department.tpl_id=0`, allegati T dei messaggi, messaggi).
- Messaggio (`updatetpl`): UPDATE `updated=NOW()`, `subject` (non sanificato), `body` (sanitize);
  allegati inline T con il bug di `keepOnlyFileIds` (lista per indice); bozze `tpl.<code>.<tpl_id>`
  (allegati delle bozze e bozze).
- Messaggio mancante (`implement`): INSERT `email_template`, allegati inline dei file citati, bozze
  `tpl.<code><tpl_id>` dell'agente (namespace senza punto, come il PHP).
- "Carica il testo di sistema": solo UI (YAML iniziale dell'installazione PHP), salvato con updatetpl.

## Diagnostica — `/admin/emails/diagnostic` (scp/emailtest.php)
`sendTestEmail`: `sendMail` con l'email di sistema scelta, corpo sanificato, Message-ID classe "?",
senza thread; poi bozze `email.diag`. Email identica al PHP (verificata via Mailpit).

## Filtri — `/admin/filters` (scp/filters.php)
`saveFilter(tx, id|null, vars)` = `Filter::update` (`adminsys/filter.ts`; regole in `adminsys/filter-rules.ts`,
azioni in `adminsys/filter-actions.ts`):
- `filter`: isactive, flags, target (`Email` se il target è un id email → `email_id`), name,
  execorder, email_id, match_all_rules, stop_onmatch, notes (sanitize); `created` (nuovo),
  `updated=NOW()` se cambia.
- `filter_action`: `N<tipo>` INSERT (type, filter_id, sort=indice, configuration JSON, updated),
  `I<id>` aggiorna configuration/sort, `D<id>` DELETE. Configurazione come i form delle TriggerAction:
  ChoiceField → numero (JsonDataParser), testi striptags, messaggio sanitize, `[]` se vuota.
- `filter_rule`: tutte cancellate e reinserite (what, how, val; `created` vuoto, isactive/notes di
  default); regex senza delimitatori avvolte in `/…/iu`.
- Stranezze replicate: senza `actions[]` nessun salvataggio e nessun errore; valore d'azione vuoto →
  errore e stop; ultima azione esistente → `setFlag` ×3 (tre `Filter::update` sui dati del modello che
  ricreano le regole); errori di configurazione in `save_actions` → salvataggio parziale (azioni
  successive con configuration NULL, regole non salvate). `prepareSupportedMatches` (form L delle liste).
- Massa: enable/disable (`updated=NOW()`), delete (filtro, regole, azioni; mai la ban list).

## Form — `/admin/forms` (scp/forms.php)
`saveForm(tx, id|null, POST)`; POST passato per `Format::htmlchars($_POST, true)`.
- `form` (title, notes, instructions decodificate) salvato subito in update; `form_field` esistenti
  (label, sort, type/name se non mascherati) e nuovi (sort, label, type, name, flags dalla modalità di
  visibilità, created) salvati solo senza errori; eliminazioni immediate (risposte presenti → campo
  staccato `form_id=0`, altrimenti DELETE; `delete-data` cancella `form_entry_values`).
- **DDL**: nei form T, A, U, O un campo nuovo o un cambio di nome/tipo farebbe ricreare al PHP la
  tabella `*__cdata` (Signal model.created/updated). Next rifiuta prima di scrivere (`ddl_required`).
- Eliminazione (massa): logica, `flags |= DELETED` solo con `FLAG_DELETABLE`.
- Configurazione dei singoli campi e traduzioni restano al PHP.

## Liste — `/admin/lists` (scp/lists.php, ajax.forms.php)
- Lista nuova: `list` (name, name_plural, sort_mode, notes sanitize; htmlchars) + form `L<id>`
  ("<nome> Properties"); proprietà nuove = `form_field` (flags 12289).
- Modifica: campi cambiati della lista, ordinamento manuale degli elementi (`sort-<id>`), proprietà
  (etichetta, ordine, nome, tipo, eliminazione).
- Eliminazione: non se usata da un campo `list-<id>`; DELETE lista, form L segnato DELETED, campi del
  form eliminati (elementi lasciati come nel PHP). **Più stretto**: liste con MASK_DELETE non eliminate.
- Elementi: aggiunta (status 1, list_id, value trim, extra, properties JSON `{id campo: valore}` o
  `[]`; un valore esistente riusa l'elemento), modifica (value, extra NULL se vuoto, properties; il
  controllo di unicità del PHP non blocca mai), enable/disable (bit status), delete (`list_id=NULL`).
- Proprietà gestite: campi `text` e `memo`; altri tipi → `unsupported_property`. Lista degli stati dei
  ticket (handler) in sola lettura. Import CSV al PHP.

## Pagine — `/admin/pages` (scp/pages.php)
- `content`: type, name (striptags), body/notes (sanitize), isactive 1/0, created/updated.
- Allegati inline P con `keepOnlyFileIds(array_flip(…))` (dal 2° file nuovo il nome è l'indice).
- Bozze: dopo add `deleteForNamespace('page')`, dopo update `page.<id>%`.
- Massa: pagine predefinite protette (salvo enable); enable `UPDATE isactive=1`; disable (già
  disattive contano, in uso no, `updated=NOW()`); delete se non in uso. Traduzioni al PHP.

## Code — `/admin/queues` (scp/queues.php)
Creazione/modifica (criteri, colonne, ordinamenti, esportazioni) al PHP. Massa: enable/disable
(`flags` ± DISABLED, `updated=NOW()`), delete (solo la riga `queue`; non la coda predefinita).

## API key — `/admin/apikeys` (scp/apikeys.php)
INSERT/UPDATE `api_key` con SQL diretto: `updated=NOW()`, isactive, can_create_tickets,
can_exec_cron ('' se assenti → 0), notes; alla creazione `created`, `ipaddr` (IPv4/IPv6 valido),
`apikey` casuale 48 caratteri [A-Z0-9]. Massa: enable/disable (UPDATE isactive), delete.

## Log — `/admin/logs` (scp/logs.php)
Elenco con filtri (tipo, intervallo date, ordinamento, pagine). Eliminazione: `DELETE FROM syslog
WHERE log_id IN (…)`.

## Plugin — `/admin/plugins` (scp/plugins.php)
Elenco; enable/disable plugin (`UPDATE plugin SET isactive`) e istanze (`flags | 1`, `flags & ~1`).
Installazione, disinstallazione, configurazione ed eliminazione delle istanze richiedono il codice PHP.

## Sistema — `/admin/system`
Sola lettura: versione osTicket (bootstrap.php), Next/Node, MySQL, schema, spazio, fuso del DB.
