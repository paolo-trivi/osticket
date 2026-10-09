# 14 — Sicurezza: controlli esistenti, debolezze note, requisiti per la riscrittura

## 1. Controlli presenti in osTicket 1.18.4

| Area | Implementazione |
|---|---|
| **SQL injection** | ORM con prepared statement mysqli (bind `?`); codice legacy con `db_input()` (escape `real_escape_string` + quoting); full-text: sanitizzazione dei parameter marker (`:n`) e regex di validazione della sintassi booleana |
| **XSS (input)** | HTML degli utenti/agenti sanitizzato con **htmLawed** in `Format::safe_html()`: rimozione `head/style/script`, commenti, `form/input/button`, attributi `id, formaction, action, srcset, data*, on*`, schemi URL whitelisted (`href`: http/https/mailto/ftp…; `src`: cid/http/https/data), `<iframe>` solo dai domini `embedded_domain_whitelist`; bilanciamento tag; rimozione immagini esterne (salvo opzione); emoji rimosse |
| **XSS (output)** | `Format::htmlchars()` sui valori; variabili template con blacklist `passwd/password/authkey` |
| **CSP** | header `Content-Security-Policy: frame-ancestors <allow_iframes|'self'>; script-src 'self' 'unsafe-inline' ['unsafe-eval' nel pannello staff]; object-src 'none'`; download file: `default-src 'self'` |
| **Clickjacking** | `frame-ancestors` |
| **CSRF** | token per sessione su tutti i metodi non-GET (portale, staff, AJAX via header `X-CSRFToken`); rotazione su login |
| **Sessione** | cookie HttpOnly, Secure (se HTTPS), SameSite Strict (None se iframe consentiti), rigenerazione ID dopo login (TIME_BOMB) e periodica, TTD per sessioni vecchie, idle timeout, binding IP opzionale, invalidazione sessioni al cambio password |
| **Password** | bcrypt (phpass, cost 8), policy minima 6 char, reset via token casuale 48 char con scadenza, migrazione automatica da MD5 |
| **Brute force** | strike counter per sessione + rotazione CSRF a ogni tentativo + lockout temporaneo + alert admin |
| **2FA** | email OTP (6 cifre, 6 min, 3 tentativi), TOTP via plugin, obbligatoria opzionale |
| **Autorizzazione** | controllo esplicito in ogni controller (`checkStaffPerm`, `hasPerm`, `isAdmin`), visibilità ticket per reparto/assegnazione/referral, risposte 403/404 generiche lato cliente ("Unknown or invalid ticket ID") |
| **File** | link firmati HMAC-SHA1 con scadenza e legati a host/path; autenticazione opzionale; inline solo immagini non SVG; `Content-Disposition: attachment` forzato per tipi non sicuri; validazione estensioni/MIME (opz. strict check) |
| **Email** | Message-ID firmati HMAC (anti spoofing threading), rilevamento loop, rifiuto email da indirizzi di sistema, ban list, header auto-reply, limite ticket aperti |
| **API** | API key + IP esatto; errori non inviano email (anti-DoS) |
| **ACL IP** | lista IP per portale/pannello |
| **Crittografia** | credenziali email/OAuth cifrate AES-128-CBC con chiave derivata da `SECRET_SALT` |
| **Plugin** | verifica firma PHAR via DNS + chiave pubblica |
| **Installer** | rifiuta username prevedibili, richiede rimozione `setup/` |
| **Config file** | `ost-config.php` blocca accesso diretto; consiglio permessi read-only |

## 2. Debolezze / punti critici osservati (da correggere in una riscrittura)

1. **Crittografia senza autenticazione** (AES-CBC senza MAC) e chiave derivata da `SECRET_SALT` statico → usare AEAD (AES-GCM / libsodium secretbox) con key management.
2. **Hash di link/token basati su MD5/SHA1** (token ticket `md5(...)`, link token legacy, firma file HMAC-SHA1, `getLinkToken` md5) → HMAC-SHA256, token casuali memorizzati con scadenza.
3. **Lockout legato alla sessione**: un attaccante che non conserva il cookie bypassa il contatore → rate limiting per IP/account (es. Laravel RateLimiter).
4. **CSRF token senza scadenza**, unico per sessione; `script-src 'unsafe-inline' 'unsafe-eval'` → CSP con nonce.
5. **API key legata ad un solo IP con confronto esatto**, nessuno scope/scadenza/rotazione; chiave in chiaro nel DB → token hashati, scope, scadenza, IP CIDR opzionale.
6. **Assenza di FK** e integrità solo applicativa → vincoli DB.
7. **`SQL_MODE=''`** (no strict) → strict mode.
8. **Charset `utf8` (3 byte)** con rimozione emoji → `utf8mb4`.
9. **Datetime in ora del server DB** → UTC.
10. **Bug noti nel codice** (comportamenti da NON replicare o da decidere consapevolmente):
    - `UserAuthStrikeBackend::authTimeout()` usa il timeout degli agenti.
    - `SLA::priorityEscalation()` usa `&&` invece di `&` (sempre vero se flags≠0); flag inutilizzato.
    - Ruolo seed "Limited Access": virgola mancante → permessi `ticket.reply`/`task.create` persi.
    - `getLastUserRespondent()` usa `$this->$lastuserrespondent` (variabile variabile).
    - Overdue dei task configurabile ma non implementato.
    - `FA_SetStatus::getEventDescription` usa `Team::lookup` invece di `TicketStatus::lookup`.
    - Rotta `/scp/ajax.php/report/*` verso file inesistente.
    - Chiavi config inutilizzate (`allow_client_updates`, `show_related_tickets`, `default_task_sla_id`).
    - `getUserStats()` usa colonna `status` inesistente su `ticket` (legacy).
    - `SavedQueue::counts()` (class.search.php): la query aggregata eredita il `GROUP BY ticket_id` di `applyVisibility()` → più righe → `->one()` lancia `ObjectNotUnique` → fallback su `getTotal()` **senza agente**: i contatori delle code ignorano la visibilità (un agente di un altro reparto vede i totali di tutto l'helpdesk). La nuova app conta solo i ticket visibili.
    - `OverviewReport::getPlotData()` (dashboard): il grafico conta gli eventi di **tutti** i reparti, mentre le tabelle filtrano per i reparti dell'agente. La nuova app filtra anche il grafico.
    - Ricerca full-text (`MysqlSearchBackend::find`): prende i 500 risultati più rilevanti di tutto l'helpdesk **prima** di applicare la visibilità, quindi un agente con accesso limitato può non trovare ticket che vede. La nuova app applica visibilità e paginazione su tutti i risultati.
    - Liste delle code: l'ordinamento usa solo le chiavi della coda (a pari merito un ticket può ripetersi o mancare tra le pagine) e il totale della paginazione è il contatore della coda, calcolato con condizioni diverse dalla lista. La nuova app usa `ticket_id` come ultima chiave e conta il totale con le stesse condizioni della lista; i contatori del menu restano come il PHP (ma con la visibilità).
11. **Upload**: validazione MIME basata su estensione/`fileinfo`; nessun antivirus → integrare scansione (ClamAV) se richiesto (ambito sanitario).
12. **Log**: `syslog` può contenere dati personali (email, IP) → policy di retention/GDPR.
13. **Dati sanitari** (contesto ospedaliero): i ticket possono contenere dati sanitari; prevedere cifratura a riposo, audit di accesso (in osTicket l'audit è solo via plugin), minimizzazione nelle email (le notifiche includono il corpo del messaggio).

## 3. Cronologia patch di sicurezza recenti (da trasformare in test di regressione)
- **06/2026 (v1.18.4)**: FAQ Print, User AJAX (controlli permessi), Thread Entry Reuse, Thread Actions, User Org AJAX, Pwreset Token Expiration, Template Vars (blacklist variabili sensibili), Login-Required Policy, Note AJAX, Ticket Field View, Hash Comparison (`hash_equals`), CSRF (metodi non-GET), API Key Logging (mascheramento), Staff Password Reset, Request Method, Recipient Name (escape), File Exception Handling, File URL Signatures, Inline SVGs (no inline), HTTP_REFERER typo, API Keys, Thread Entry Titles (escape), Email Display Names, Bootstrap Tooltip (XSS), Full-Text Search (injection parameter marker).
- **01/2026 (v1.18.3)**: Pwreset Hardening, Request Handling, HTML/PDF Hardening, mPDF Print, Ensure Session ID.
- **01/2025**: Syslog AJAX, iFrame Logins.
Ogni voce indica una classe di vulnerabilità (IDOR su endpoint AJAX, XSS in campi titolo/nome, uso improprio di token) che la riscrittura deve coprire con test automatici.
