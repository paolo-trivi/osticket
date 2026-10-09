# 12 — Internazionalizzazione, installazione, aggiornamento schema, CLI

## 1. Internazionalizzazione (i18n)

### 1.1 Traduzione dell'interfaccia (stringhe nel codice)
- Funzioni gettext-like (definite in `Internationalization::bootstrap()` e `class.translation.php`): `__($msg)` (lingua dell'utente corrente), `_N($sing, $plur, $n)`, `_P($context, $msg)`, `_NP(...)`, `_S($msg)` (lingua di **sistema**, usata per log/email di sistema), `_NS`, `_L($msg, $locale)`, `_NL`. Marker `/* @trans */` per estrazione.
- Cataloghi compilati `.mo` dentro **language pack** `include/i18n/<lang>.phar` (o cartella), contenenti anche le versioni tradotte dei YAML seed, template email/pagine, help tips, file JS (`js/redactor.js` lingua). `en_US` è incluso in chiaro.
- `TextDomain::configureForUser($user)` imposta il dominio di traduzione all'inizio della richiesta.
- Lingua corrente: preferenza utente/agente (se lingua abilitata) → `$_SESSION['::lang']` (selettore bandiere / `?lang=`) → `Accept-Language` del browser (match RFC 2616 con q-values, prefissi) tra le lingue configurate → `system_language`.
- Lingue configurate: primaria (`system_language`) + secondarie (`secondary_langs`, CSV); le secondarie abilitano: selettore lingua sul portale, traduzione contenuti DB, template email per lingua.
- Locale (formati data/numero): `default_locale` / preferenza agente; formattazione con `IntlDateFormatter` (ICU), separatore CSV dipendente dal locale.
- RTL: lingue con `direction: rtl` → `css/rtl.css`.
- File JS di traduzione serviti da `/ajax.php/i18n/<lang>/<tag>`.

### 1.2 Traduzione dei contenuti (DB)
- Tabella `translation` (doc 02): per ogni oggetto+campo (`_H("dept.name.5")`) e lingua secondaria.
- Oggetti traducibili: nomi reparti, help topic, team? (no), SLA? , stati ticket, titoli/istruzioni form, label/hint/choices campi, elementi liste, categorie FAQ, FAQ (domanda+risposta = `article`), pagine (`article` `{name, body}`), azienda.
- UI: icona bandiera accanto ai campi traducibili (jquery.translatable) → `/scp/ajax.php/i18n/translate/<tag>` (GET elenco, POST salva).
- Lettura: `getLocal('name')` → `CustomDataTranslation::translate($tag, $lang)` con fallback al testo originale.
- Email in lingua: `UserAccount::LANG_MAILOUTS` (lingua preferita dell'utente) per access-link/registrazione; il gruppo template del reparto definisce la lingua delle notifiche ticket.

### 1.3 Help tips
YAML `include/i18n/<lang>/help/tips/<namespace>.yaml` (`title`, `content`, `links`) serviti come JSON (`/ajax.php/help/tips/<ns>`), mostrati con icone "?" nelle pagine admin/staff.

## 2. Installazione (`setup/install.php`, `setup/inc/class.installer.php`)

### 2.1 Prerequisiti verificati (`install-prereq.inc.php`)
PHP ≥ 8.2, estensioni `mysqli` (obbl.), consigliate `gd`, `imap`, `xml`, `xml-dom`, `json`, `mbstring`, `phar`, `intl`, `apcu`, `zip`, `fileinfo`, `openssl`. `include/ost-config.php` esistente e scrivibile (copiato da `ost-sampleconfig.php`). MySQL ≥ 5.5.

### 2.2 Form di installazione
- **System**: nome helpdesk, email di sistema (default), lingua primaria.
- **Admin**: nome, cognome, email (≠ email di sistema), username (non `admin`, `admins`, `username`, `osticket`), password (+ conferma; policy).
- **Database**: prefisso tabelle (deve terminare con `_`), host (`host[:porta]`), nome DB (creato se non esiste), utente, password.
- Timezone (rilevata dal browser via jstz).

### 2.3 Algoritmo
1. Validazioni; connessione MySQL; versione; crea/seleziona DB; verifica che il prefisso non sia già usato (`<prefix>config`); `ALTER DATABASE ... utf8 utf8_general_ci`.
2. Definisce `TABLE_PREFIX`, `SECRET_SALT` temporaneo, tabelle.
3. Per ogni stream (`core`): verifica che `md5(install-mysql.sql)` = signature in `include/upgrader/streams/core.sig`, poi esegue lo script SQL sostituendo `%TABLE_PREFIX%`.
4. `Internationalization::loadDefaultData()` (ordine: SLA, reparti, form, liste, help topic, filtri, team, organizzazioni, stati ticket, ruoli, eventi, file, sequenze, colonne/ordinamenti/code, schedule; priorità; config `core` dal YAML; pagine (landing, thank-you, offline, registration-*, pwreset-*, access-link, banner-*, email2fa-staff) con impostazione `*_page_id`; dimensione max file = `upload_max_filesize`; canned di esempio; gruppo template email + tutti i template).
5. `Signal::send('system.install')` (crea tabella `_search` e avvia indicizzazione).
6. Crea **agente admin** (attivo, admin, reparto e ruolo = primi creati, permessi globali: user.*, org.*, faq.manage, emails.banlist, visibility.departments, visibility.agents), con accesso esteso a **tutti** gli altri reparti con lo stesso ruolo.
7. Crea **3 email di sistema**: "Support" `<email indicata>`, "osTicket Alerts" `alerts@<dominio>`, `noreply@<dominio>` (tutte nel reparto default).
8. Config `core`: `default_email_id`, `alert_email_id`, `default_dept_id`, `default_sla_id`, `schedule_id`, `default_template_id`, `default_timezone`, `admin_email`, `schema_signature`, `helpdesk_url` (URL rilevato), `helpdesk_title`.
9. Nome azienda nel form Company.
10. Riscrive `ost-config.php`: `OSTINSTALLED=TRUE`, credenziali DB, prefisso, admin email, **`SECRET_SALT` = 32 caratteri casuali**.
11. Crea il ticket di benvenuto (`templates/ticket/installed.yaml`, origin `api`, senza auto-risposte/alert) e lo collega all'organizzazione seed.
12. Ricostruisce le tabelle `*__cdata`; log "osTicket installed!".
13. Pagina finale: raccomanda di rimuovere `setup/` e rendere `ost-config.php` read-only; link a pannello staff.

Installazione via CLI: `setup/cli/` (stesso Installer).

## 3. Aggiornamento schema (upgrader)

- Ogni versione dello schema è identificata da una **signature** (md5 di 8 caratteri nei nomi dei file; signature completa in `core.sig`).
- `osTicket::isUpgradePending()`: per ogni stream in `include/upgrader/streams/*.sig`, confronta con `config.<stream>.schema_signature` → se diverso il sistema va **offline** per i non-admin e il pannello mostra "Upgrade Now".
- `DatabaseMigrater::getPatches()`: catena di file `<from>-<to>.patch.sql` a partire dalla signature corrente fino a quella target (scelta del percorso per hash).
- Per ogni patch: esegue lo SQL (con `%TABLE_PREFIX%`), poi l'eventuale `<to>.task.php` (migrazione dati PHP, può essere eseguita a più step via AJAX `/scp/ajax.php/upgrader`), poi `<to>.cleanup.sql`; aggiorna la signature.
- UI: `scp/upgrade.php` (prerequisiti, avanzamento con `upgrader.js`, log in syslog), solo admin. CLI: `php manage.php upgrade`.
- Durante l'upgrade le sessioni usano l'handler PHP di sistema e i plugin non vengono caricati.
- In una riscrittura: sostituire con migrazioni del framework a partire dallo schema finale + uno script ETL per importare un DB osTicket 1.18 esistente.

## 4. CLI (`php manage.php <modulo> [azione] [opzioni]`)

| Modulo | Azioni / scopo |
|---|---|
| `agent` | `import` (CSV), `export`, `list`, `login` (test autenticazione), `backends` (elenco backend auth); opzioni: file, verbose, welcome email |
| `user` | `import`, `export`, `activate`, `lock`, `set-password`, `list`; opzioni: file, org_id, verbose |
| `org` | `import`, `export` |
| `list` | `import`, `export`, `show` (liste custom) |
| `file` | `list`, `export`, `import`, `zip`, `dump`, `load`, `migrate` (spostare file tra backend di storage), `backends`, `expunge`; filtri per ticket/file id/data/backend |
| `cron` | `fetch` (solo mail fetch), `search` (reindicizzazione full-text) |
| `export` | dump completo del DB (opz. compresso) — con segnale `export.tables` |
| `import` | import di un dump (opz. drop tabelle, `--prime-time`) |
| `i18n` | language pack: `list` (lingue disponibili da Crowdin), `build` (scarica e compila un language pack `.phar`), `similar` (stringhe simili), `make-pot` (estrae le stringhe traducibili), `sign` (firma il pack) |
| `deploy` | deploy da repository git a una directory di installazione (copia file, esclude setup, imposta GIT_VERSION) |
| `unpack` | estrae un pacchetto release |
| `package` | crea pacchetto release (con test) |
| `upgrade` | esegue l'upgrade schema |
| `serve` | server di sviluppo PHP built-in |

Implementazione: `include/class.cli.php` (`Module` con parser argomenti/opzioni stile argparse), moduli in `include/cli/modules/`.

## 5. Test (`setup/test/`)
Runner `php setup/test/run-tests.php`: lint PHP, controllo stringhe gettext, test unitari su ORM, formattazione, parsing email (fixture `.eml`), validatori, ecc. Utili come **casi di test di regressione** in una riscrittura.
