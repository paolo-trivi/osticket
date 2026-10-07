# 01 — Architettura generale, bootstrap e ciclo di vita della richiesta

> Versione analizzata: **osTicket v1.18.4** (branch `develop` = `1.18.x`, commit `8d38b06`, giugno 2026).
> `MAJOR_VERSION = '1.18'`, `THIS_VERSION = '1.18-git'`. PHP ≥ 8.1, MySQL/MariaDB obbligatorio.

## 1. Branch del repository e scelta della baseline

| Branch | Ultimo commit | Stato |
|---|---|---|
| `develop` | 2026-06-17 "Add Release Notes for v1.18.4" | **Baseline scelta** (identico a `1.18.x`) |
| `1.18.x` | = `develop` | ramo di manutenzione corrente |
| `1.17.x` | v1.17.8 | manutenzione precedente (solo security) |
| `1.16.x` … `1.8.x` | — | rami storici |
| `develop-next` | 2020-11 | sperimentale, abbandonato (7459 commit dietro) |
| `master` | 2019-07 (v1.12.2) | obsoleto, non più aggiornato |
| `dependabot/*`, `revert-3168-*` | — | rami tecnici |

Tutto il documento descrive `develop` @ v1.18.4.

## 2. Natura dell'applicazione

osTicket è un **help desk / ticketing system** web, monolitico, PHP "classico" (niente framework MVC esterno, niente Composer per il core). Caratteristiche:

- **Page-controller**: ogni URL corrisponde ad un file `.php` fisico (es. `/scp/tickets.php`, `/open.php`). Il file include un bootstrap comune, esegue la logica (spesso in base a `$_REQUEST['a']` = "action") e poi include un template `.inc.php`.
- **Mini-router** solo per gli endpoint AJAX (`/ajax.php/...`, `/scp/ajax.php/...`) e per l'API (`/api/http.php/...`) tramite `class.dispatcher.php` (pattern regex stile Django).
- **ORM proprietario** (`class.orm.php`, ispirato al Django ORM: `objects()->filter(...)`, `__` per attraversare relazioni, `Q`, `annotate`, `aggregate`).
- **Event bus** sincrono (`Signal::connect/send`).
- **Plugin system** con istanze configurabili.
- **Due front-end server-rendered**: portale clienti (root `/`) e pannello agenti/admin (`/scp/` = "Staff Control Panel"). JS: jQuery 3.7 + jQuery UI + PJAX + Redactor (editor rich-text) + Select2 + Raphael (grafici dashboard).
- **Integrazione email bidirezionale**: fetch IMAP/POP (cron) o piping MTA → creazione ticket / risposte; invio SMTP/`mail()` via Laminas-Mail.
- **API REST minimale** (crea ticket JSON/XML/email, esegui cron) autenticata via API key + IP.

Nessuna stored procedure, trigger o view SQL: **tutta la logica è applicativa**. Uniche "tabelle derivate" sono le *materialized view* `*__cdata` ricostruite dal PHP (vedi doc 02).

## 3. Layout delle directory

```
/                         Portale CLIENTE (front-end pubblico)
├── index.php             Landing page (pagina "landing" + KB in evidenza)
├── open.php              Apertura nuovo ticket (form dinamico per help topic)
├── tickets.php           Lista/visualizzazione/risposta ticket del cliente
├── view.php              Accesso al ticket via link/token (guest)
├── login.php / logout.php / pwreset.php / account.php (registrazione) / profile.php
├── kb/                   Knowledge base pubblica (index.php, faq.php)
├── pages/index.php       Pagine statiche CMS (tabella content, tipo 'other') /pages/<slug>
├── ajax.php              Router AJAX lato cliente
├── file.php              Download allegati (link firmati)
├── avatar.php, logo.php, captcha.php
├── apps/dispatcher.php   Router per "app" di plugin lato cliente
├── secure.inc.php        Include per pagine che richiedono login cliente
├── client.inc.php        Bootstrap del portale cliente
├── main.inc.php          Bootstrap comune (DB, config, sessione)
├── bootstrap.php         Costanti, nomi tabelle, init PHP
├── offline.php           Pagina "sistema offline"
├── assets/default/       CSS/LESS/immagini del tema cliente
├── css/ js/ images/      Asset condivisi (jQuery, Redactor, Select2, FontAwesome…)
│
├── scp/                  STAFF CONTROL PANEL (agenti + admin)
│   ├── staff.inc.php     Bootstrap pannello staff (auth, CSRF, nav)
│   ├── index.php         → redirect a tickets.php
│   ├── tickets.php       Code (queue), vista ticket, azioni, apertura ticket da staff
│   ├── tasks.php         Task
│   ├── users.php, orgs.php            Directory utenti/organizzazioni
│   ├── kb.php, faq.php, categories.php, canned.php   Knowledge base e risposte predefinite
│   ├── dashboard.php     Statistiche
│   ├── directory.php     Rubrica agenti
│   ├── profile.php       Profilo agente
│   ├── admin.inc.php     Bootstrap area admin (richiede isAdmin)
│   ├── settings.php      Impostazioni (t=system|tickets|tasks|agents|users|pages|emails|kb|autoresp|alerts)
│   ├── emails.php, emailsettings.php, emailtest.php, banlist.php, templates.php
│   ├── helptopics.php, filters.php, slas.php, schedules.php, forms.php, lists.php,
│   │   pages.php, apikeys.php, plugins.php, queues.php, departments.php,
│   │   teams.php, roles.php, staff.php, logs.php, audits.php, system.php
│   ├── ajax.php          Router AJAX staff (grande tabella di rotte)
│   ├── apps/dispatcher.php
│   ├── upgrade.php, autocron.php, export.php, logo.php, login.php, pwreset.php
│   ├── css/ js/ images/
│
├── api/                  API
│   ├── http.php          Router REST (POST /tickets.{json|xml|email}, POST /tasks/cron)
│   ├── cron.php          Cron da CLI (php api/cron.php)
│   ├── pipe.php          Piping email da MTA (stdin)
│   └── api.inc.php       Bootstrap API (API_SESSION, APICALL)
│
├── include/              TUTTO il codice applicativo
│   ├── class.*.php       ~130 classi dominio/infrastruttura
│   ├── ajax.*.php        Controller AJAX (una classe per area)
│   ├── api.*.php         Controller API
│   ├── staff/*.inc.php   Template HTML pannello staff/admin
│   ├── client/*.inc.php  Template HTML portale cliente
│   ├── */templates/      Template parziali riutilizzabili (.tmpl.php)
│   ├── i18n/en_US/       Dati seed (YAML) + template email/pagine + help tips
│   ├── i18n/vendor/      (lingue aggiuntive, language pack .phar)
│   ├── upgrader/         Motore di migrazione schema + stream patch SQL
│   ├── cli/              Tool CLI (manage.php): agent, user, org, cron, export, import, i18n, deploy, upgrade, serve, file, list, package
│   ├── laminas-mail/     Libreria email (Composer vendor isolato)
│   ├── mpdf/             Generazione PDF (stampa ticket)
│   ├── pear/             PEAR legacy (Mail, Net_SMTP, Crypt, Auth_SASL…)
│   ├── htmLawed.php      Sanitizzazione HTML
│   ├── ost-sampleconfig.php → copiato come ost-config.php in installazione
│   └── plugins/updates.pem  Chiave pubblica verifica firma plugin
│
├── setup/                Installer web + CLI, test, script MTA
│   ├── install.php       Wizard installazione
│   ├── inc/class.installer.php
│   ├── inc/streams/core/install-mysql.sql   Schema completo
│   ├── scripts/          automail.pl / automail.php (piping), rcron.php (cron remoto)
│   └── test/             Test (lint, unit su ORM/format/mail-parse)
└── manage.php            Entry point CLI (php manage.php <modulo> ...)
```

## 4. Configurazione statica: `include/ost-config.php`

Creato dall'installer partendo da `ost-sampleconfig.php`. Costanti PHP:

| Costante | Significato |
|---|---|
| `OSTINSTALLED` | `TRUE` dopo l'installazione; se `FALSE` redirect a `setup/install.php` |
| `SECRET_SALT` | Segreto casuale (32 char) usato per crittografia (`Crypto`), chiavi APCu, firme link file, token |
| `ADMIN_EMAIL` | Email admin di fallback (errori fatali DB) |
| `DBTYPE` | Sempre `mysql` |
| `DBHOST` | Host, accetta lista separata da virgola (failover: prova in sequenza), `host:port`, `host:/socket`, prefisso `p:` = connessione persistente |
| `DBNAME`, `DBUSER`, `DBPASS` | Credenziali |
| `TABLE_PREFIX` | Prefisso tabelle (default `ost_`) |
| `DBCONNECT_TIMEOUT` (opz.) | Timeout connessione (default 3s) |
| `DBSSLCA`, `DBSSLCERT`, `DBSSLKEY` (opz.) | TLS verso MySQL |
| `MAIL_EOL` (opz.) | Terminatore riga header email |
| `ROOT_PATH` (opz.) | Path URL dell'installazione, se l'autodetect fallisce |
| `TRUSTED_PROXIES` | IP/CIDR dei reverse proxy fidati (abilita `X-Forwarded-For/Proto/Port`) |
| `LOCAL_NETWORKS` | IP/CIDR rete locale (default `127.0.0.0/24`) |
| `SESSION_SESSID` | Nome cookie sessione (default `OSTSESSID`) |
| `SESSION_BACKEND` (opz.) | `database` (default), `memcache`, `memcache.database`, `system` |
| `MEMCACHE_SERVERS` (opz.) | Lista `host:port` |

Costanti derivate in `Bootstrap::loadConfig()`: `SESSION_SECRET = md5(SECRET_SALT)`, `SESSION_TTL = 86400`.

Tutta la **configurazione dinamica** sta invece nella tabella `config` (namespace `core` e altri), vedi doc 02 §config e doc 13.

## 5. Sequenza di bootstrap (ogni richiesta)

### 5.1 `bootstrap.php` (incluso da `main.inc.php`)
1. Calcola `ROOT_DIR`, `INCLUDE_DIR`, `PEAR_DIR`, `SETUP_DIR`, `CLIENTINC_DIR`, `STAFFINC_DIR`, `UPGRADE_DIR`, `I18N_DIR`, `CLI_DIR`.
2. Definisce `GIT_VERSION`, `MAJOR_VERSION`, `THIS_VERSION`.
3. `include_path = ./:include/:include/pear/`.
4. Carica `class.osticket.php`, `class.misc.php`, `class.http.php`, `class.validator.php`.
5. Calcola `ROOT_PATH` (path URL) con `osTicket::get_root_path()` confrontando `SCRIPT_NAME` col path fisico.
6. `Bootstrap::init()`: disabilita `register_globals`, `allow_url_fopen/include`, `session.use_trans_sid`; error_reporting senza notice/warning/deprecated; **`date_default_timezone_set('UTC')`** (PHP lavora sempre in UTC).
7. `THISPAGE = Http::url()`, `DEFAULT_MAX_FILE_UPLOADS`, `DEFAULT_PRIORITY_ID = 1`.

### 5.2 `main.inc.php`
1. Blocca accesso diretto al file.
2. `Bootstrap::loadConfig()` → include `ost-config.php` (o redirect a setup).
3. `Bootstrap::defineTables(TABLE_PREFIX)` → costanti `*_TABLE` (es. `TICKET_TABLE = ost_ticket`).
4. `Bootstrap::i18n_prep()` → UTF-8 ovunque; polyfill `mb_*` se manca mbstring.
5. `Bootstrap::loadCode()` → carica util, controller, translation, signal, model, user, auth, pagenate, log, crypto, page, format, validator, **mysqli.php**, i18n, queue.
6. `Bootstrap::connect()` → `db_connect()` per ogni host in `DBHOST` finché uno risponde. Alla connessione imposta: `SET NAMES utf8`, `COLLATION_CONNECTION=utf8_general_ci`, **`SQL_MODE=''`** (nessuna modalità strict!), **`TIME_ZONE='SYSTEM'`**, autocommit ON.
7. Sovrascrive `REMOTE_ADDR` con l'IP reale risolvendo la catena `X-Forwarded-For` solo se l'IP chiamante è in `TRUSTED_PROXIES`.
8. `$ost = osTicket::start()`:
   - `Internationalization::bootstrap()`
   - `new osTicket()` → `new OsticketConfig()` (carica tutte le righe `config` namespace `core`), avvia sessione (`osTicketSession::start(SESSION_SESSID, SESSION_TTL)`), crea `CSRF('__CSRFToken__')`, `Company`, `PluginManager`.
   - `$ost->plugins->bootstrap()` (se nessun upgrade pendente): carica e inizializza i plugin attivi.
   - `$ost->searcher = new SearchInterface()` (indicizzazione full-text).
9. Se `force_https` e richiesta in HTTP: GET → redirect 301 a https, altri metodi → 400.
10. `DEFAULT_PAGE_LIMIT` = `config.max_page_size` (default 25).
11. Estrae messaggi di sistema persistiti in sessione `$_SESSION['::sysmsgs']` → `$msg`, `$warn`, `$errors`.

Variabili globali rese disponibili: `$ost` (sistema), `$cfg` (config), `$session`, poi `$thisstaff` (agente loggato) o `$thisclient` (cliente loggato), `$nav`, `$errors`, `$msg`, `$warn`.

### 5.3 `client.inc.php` (portale cliente)
1. Include `main.inc.php`.
2. ACL IP: `Validator::check_acl('client')`. Config `acl` = lista IP consentiti (CSV); `acl_backend`: 0=Disabilitato, 1=Tutti (client+staff), 2=Solo portale cliente, 3=Solo pannello staff. Se la lista è vuota o il backend non riguarda l'interfaccia corrente → accesso libero; con backend 2 un agente già loggato bypassa il controllo sul portale. Altrimenti l'IP del client deve essere **esattamente** in lista (no CIDR).
3. Se sistema offline (`config.isonline=0` o upgrade pendente) → `offline.php` (eccetto `logo.php`, `file.php`).
4. `$thisclient = UserAuthenticationBackend::getUser()` (sessione `_auth.user`).
5. `?lang=xx` cambia lingua di sessione; `TextDomain::configureForUser()`.
6. **CSRF**: per POST/PUT/PATCH/DELETE richiede token valido (`__CSRFToken__` nel POST o header `X-CSRFToken`) altrimenti redirect a index.
7. Aggiunge `<meta name="csrf_token">` all'head.
8. `PAGE_LIMIT`, `SESSION_MAXLIFE` (timeout idle cliente).
9. `$nav = new UserNav(...)`.
10. Se account con flag "reset password obbligatorio" → forza `profile.php`.

`secure.inc.php` in più: se non loggato salva `dest` in sessione e mostra `login.php`.

### 5.4 `scp/staff.inc.php` (pannello agenti)
1. Include `main.inc.php`, ACL IP `staff`.
2. `$thisstaff = StaffAuthenticationBackend::getUser()`.
3. Se non loggato/non valido → salva destinazione, redirect `scp/login.php` (messaggio "Session timed out" se scaduto).
4. Se non admin: staff disattivato → login; sistema offline/upgrade pendente → logout forzato.
5. `PAGE_LIMIT` = preferenza agente, `SESSION_MAXLIFE` = timeout agente; `refreshSession()`.
6. CSRF obbligatorio su metodi non sicuri (400 se fallisce).
7. Upgrade pendente → mostra `upgrade.php` (solo admin può eseguirlo).
8. `$nav = new StaffNav($thisstaff)` (menu a tab in base ai permessi).
9. Cambio password forzato → `profile.php`; 2FA obbligatoria non configurata → `profile.php`.

`scp/admin.inc.php`: include `staff.inc.php` e richiede `$thisstaff->isAdmin()`, usa `AdminNav`.

### 5.5 API (`api/api.inc.php`)
Definisce `API_SESSION` (sessione stateless per nuove sessioni) e `APICALL`, poi `main.inc.php`. Nessun CSRF; autenticazione per API key.

## 6. Pattern di una pagina "page-controller" (esempio `scp/tickets.php`)

```
require('staff.inc.php');
// 1. carica entità da ?id=  (Ticket::lookup) e verifica accesso ($ticket->checkStaffPerm($thisstaff))
// 2. se POST: switch($_POST['a']) { case 'reply': ... case 'postnote': ... case 'edit': ... }
//    - valida, chiama metodi di dominio ($ticket->postReply($vars,$errors)),
//    - imposta $msg / $errors['err'], eventualmente redirect
// 3. sceglie il template: $inc = 'ticket-view.inc.php' | 'templates/queue-tickets.tmpl.php' | 'ticket-open.inc.php'
// 4. require(STAFFINC_DIR.'header.inc.php'); require(STAFFINC_DIR.$inc); require(STAFFINC_DIR.'footer.inc.php');
```

Le pagine admin seguono lo stesso schema con `a=add|update|mass_process` e azioni di massa su `ids[]` (`enable`, `disable`, `delete`, `sort`).

PJAX: se la richiesta ha header `X-PJAX`, header/footer emettono solo il frammento di contenuto (navigazione parziale senza reload).

## 7. Router (`class.dispatcher.php`)

- `patterns($prefix, url(...), url(...))` crea un `Dispatcher`; `url($regex, $func, $args, $method)`; helper `url_get`, `url_post`, `url_delete`.
- `$func` può essere `'file.php:Classe'` + metodo: il file viene incluso on-demand, la classe istanziata, viene chiamato `$class->access()` (403 se false) e poi il metodo con i gruppi regex catturati come argomenti posizionali (+ eventuali args statici).
- Dispatcher annidati: il match del prefisso viene rimosso e il resto passato al sotto-dispatcher.
- Emulazione metodo: POST con `_method=PUT|PATCH|DELETE`.
- Nessun match → HTTP 400 "URL not supported".
- Il path viene preso da `PATH_INFO` (es. `/scp/ajax.php/tickets/123/assign`).
- I plugin possono aggiungere rotte via segnali `ajax.scp`, `ajax.client`, `api`, `apps.scp`, `apps.admin`.

Le rotte complete sono documentate in **doc 14 (API & AJAX)**.

## 8. Cron e processi batch

Entry point: `php api/cron.php` (CLI), `POST /api/tasks/cron` (HTTP con API key `can_exec_cron`), oppure **autocron** (`scp/autocron.php`, chiamato via `<img>` da ogni pagina staff: risponde subito con una GIF 1×1, poi chiude la sessione e lavora; max 1 volta ogni 180 s per sessione agente). L'autocron esegue sempre `TicketMonitor`, con prob. 1/4 ricalcola i contatori delle code, con prob. 1/20 `CleanOrphanedFiles`, e **solo se `enable_auto_cron=1`** il `MailFetcher`; infine `Signal::send('cron', ['autocron'=>true])`.

`Cron::run()` (se nessun upgrade pendente), ordine:
1. `MailFetcher` → `osTicket\Mail\Fetcher::run()`: per ogni mailbox attiva con `fetchfreq` scaduto, scarica fino a `fetchmax` messaggi, li trasforma in ticket/risposte (doc 06).
2. `TicketMonitor` → `Ticket::checkOverdue()` (marca overdue e manda alert) + `Lock::cleanup()` (lock scaduti).
3. `PurgeLogs` → con probabilità 1/300 cancella `syslog` più vecchi di `log_graceperiod` mesi.
4. `CleanExpiredSessions` → elimina sessioni scadute.
5. `CleanPwResets` → elimina token reset password (`config` namespace `pwreset`) più vecchi di `pw_reset_window` minuti.
6. `CleanOrphanedFiles` (prob. 1/9) → elimina `file` senza `attachment` (non logo/backdrop) creati da >1 giorno.
7. `PurgeDrafts` → elimina bozze più vecchie (doc 06).
8. `MaybeOptimizeTables` → OPTIMIZE casuale di `lock`, `syslog`, `draft`.
9. `Signal::send('cron', null, ['autocron'=>false])` → listener: ricostruzione tabelle `__cdata` mancanti, re-indicizzazione full-text (`MysqlSearchBackend::IndexOldStuff`, batch), plugin.

Pianificazione consigliata: ogni 5 minuti.

## 9. Componenti trasversali

| Componente | File | Ruolo |
|---|---|---|
| Config | `class.config.php` | `Config` key/value per namespace su tabella `config`, con default e override in sessione |
| ORM | `class.orm.php` | Modelli, QuerySet, compilatore SQL MySQL, cache identità |
| Accesso DB legacy | `mysqli.php` | `db_query`, `db_input` (escape+quote), `db_fetch_array`… usato da classi legacy (API key, template email, syslog, banlist) |
| Segnali | `class.signal.php` | Pub/sub sincrono |
| Router | `class.dispatcher.php` | Rotte AJAX/API |
| Controller AJAX | `class.ajax.php`, `class.controller.php` | `AjaxController` (richiede staff loggato, risposte JSON/HTML, `exerr`) |
| Sessioni | `class.ostsession.php` | Handler DB/memcache |
| CSRF | `class.csrf.php` | Token per sessione, TTL |
| Crypto | `class.crypto.php` | AES (openssl) con chiave derivata da `SECRET_SALT` + sub-key |
| Formattazione | `class.format.php` | Sanitizzazione HTML (htmLawed), date, HTML→testo, slug, file size |
| Validazione | `class.validator.php` | email, IP/CIDR, URL, password, ACL IP |
| i18n | `class.i18n.php`, `class.translation.php` | gettext `.mo` in phar, traduzioni contenuti DB |
| Mail | `class.mail*.php`, `class.email.php`, `class.mailer.php`, `class.mailfetch.php`, `class.mailparse.php` | Laminas-Mail |
| File | `class.file.php`, `class.attachment.php` | Storage chunked in DB o backend plugin |
| PDF | `class.pdf.php` | mPDF (stampa ticket/task) |
| Export | `class.export.php` | CSV/XLS code ticket, audit |
| Import | `class.import.php` | CSV utenti/org/liste |
| Plugin | `class.plugin.php`, `class.app.php` | Caricamento, istanze, configurazione |
| Log | `class.log.php` + `osTicket::log()` | Tabella `syslog` + alert email admin |
| Variabili template | `class.variable.php` | `%{ticket.number}`, `%{recipient.name.first}` ecc. |
| Ricerca | `class.search.php` | Full-text MySQL su `_search`, ricerca avanzata, criteri queue |
| Code (queue) | `class.queue.php` | Code personalizzabili, colonne, ordinamenti, export |
| Business hours | `class.schedule.php`, `class.businesshours.php` | Calcolo due date con orari lavorativi e festività |

## 10. Dipendenze esterne (vendor inclusi nel repo)

- **Laminas-Mail** (+ laminas-validator, laminas-stdlib, laminas-mime, symfony polyfill): parsing/trasporto mail, IMAP/POP3/SMTP, OAuth2 XOAUTH2.
- **mPDF 8.2.7**: PDF.
- **htmLawed 1.2.15**: filtro HTML.
- **PEAR**: `Mail`, `Net_SMTP`, `Net_Socket`, `Auth_SASL`, `Crypt_*` (legacy), `Math_BigInteger`.
- **PasswordHash.php** (phpass) per hash password legacy; il core usa `password_hash` (bcrypt) — vedi doc 08.
- **Spyc** (YAML parser), `JSON.php` (encoder legacy), `html2text.php`, `tnef_decoder.php` (allegati winmail.dat), `class.base32.php` (TOTP).
- JS: jQuery 3.7.0, jQuery UI 1.13.2, Redactor (editor WYSIWYG, licenza commerciale bundle), Select2, Typeahead, jquery.pjax, Raphael/gRaphael (grafici), fabric.js (crop avatar/immagini), jstz (timezone detection), filedrop (upload drag&drop), spectrum (color picker).

## 11. Requisiti runtime

PHP 8.1–8.3 con estensioni: `mysqli` (obbl.), `gd`, `imap`/`laminas`, `mbstring`, `intl`, `json`, `xml`, `phar`, `openssl`, `fileinfo`, `zip` (opz.), `apcu` (consigliato: cache metadati ORM e cache modelli), `memcache` (opz.). MySQL ≥ 5.5 / MariaDB; charset `utf8` (3 byte; le emoji vengono rimosse con `Format::strip_emoticons`).

## 12. Gestione del tempo (CRITICO per una riscrittura)

- PHP gira in **UTC** (`date_default_timezone_set('UTC')`).
- MySQL sessione usa `TIME_ZONE='SYSTEM'`; le colonne `datetime` sono popolate quasi sempre con `NOW()` lato SQL → **i datetime nel DB sono nell'ora del server MySQL**, non UTC.
- `OsticketConfig::getDbTimezone()` determina il fuso del DB (`DbTimezone::determine()`, euristica su offset/DST) e lo mette in sessione; `Format::datetime()` converte da fuso DB al fuso utente (preferenza agente/cliente → `default_timezone` di sistema).
- Formati di data in sintassi **ICU** (`MM/dd/y h:mm a`) e non `date()` PHP, salvo `date_formats='custom'`.
- In una riscrittura: salvare tutto in UTC e convertire in presentazione.

## 13. Glossario del dominio

| Termine osTicket | Significato |
|---|---|
| **Ticket** | Richiesta di supporto con numero, stato, reparto, assegnatario, SLA |
| **Thread** | Contenitore dei messaggi di un ticket/task (`thread`), con entries ed eventi |
| **Thread entry** | Singolo post: `M` messaggio del cliente, `R` risposta dell'agente, `N` nota interna |
| **Thread event** | Evento di audit (creato, assegnato, chiuso, trasferito, modificato…) |
| **Task** | Attività interna, opzionalmente legata a un ticket |
| **Agent / Staff** | Operatore del pannello `/scp` |
| **User / Client** | Utente finale che apre ticket (può non avere account) |
| **Account** | Credenziali di login di un User (`user_account`) |
| **Organization** | Azienda/gruppo di User |
| **Department (Dept)** | Reparto; possiede ticket, ha manager, SLA, email, template, membri |
| **Team** | Gruppo trasversale di agenti assegnabile ai ticket |
| **Role** | Insieme di permessi (per reparto) |
| **Help Topic** | Categoria scelta all'apertura: instrada reparto/priorità/SLA/assegnatario/form |
| **SLA** | Piano di livello di servizio: ore di grace period → due date |
| **Schedule** | Orario di lavoro/festività per calcolare la scadenza SLA |
| **Queue** | Vista salvata (criteri di ricerca + colonne + ordinamenti) |
| **Filter** | Regola automatica su ticket in ingresso (match → azioni) |
| **Canned response** | Risposta predefinita |
| **FAQ / KB** | Knowledge base con categorie |
| **Collaborator** | Utente aggiuntivo (CC) su un thread |
| **Referral** | Condivisione di un ticket con un altro agente/team/reparto senza trasferirlo |
| **Merge / Link** | Fusione di ticket (child → parent) o semplice collegamento |
| **Lock** | Blocco temporaneo di un ticket mentre un agente lo modifica |
| **Draft** | Bozza auto-salvata dell'editor |
| **Dynamic form** | Form personalizzabili (ticket, user, org, task, custom) con dati EAV |
| **Custom list** | Liste di valori per campi a scelta (incl. stati ticket) |
